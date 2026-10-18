package httpapi

import (
	"crypto/subtle"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"counter-drop/api/internal/ratelimit"
)

// --- security headers -------------------------------------------------------------------

// contentSecurityPolicy allows only this site's own scripts, styles, fonts and connections, plus the
// file-storage origin that phones upload to directly. No inline scripts, no framing, no plugins.
func (s *Server) contentSecurityPolicy() string {
	connect := []string{"'self'"}
	if o := originOf(s.Cfg.PublicAPIURL); o != "" {
		connect = append(connect, o)
	}
	if o := s.wsOrigin(); o != "" {
		connect = append(connect, o)
	}
	if st := s.Cfg.Storage; st.S3Enabled() {
		if o := originOf(st.Endpoint); o != "" {
			connect = append(connect, o)
		} else {
			// Native AWS S3: presigned URLs use the bucket's regional host.
			if region := st.Region; region != "" && region != "auto" {
				connect = append(connect, "https://"+st.Bucket+".s3."+region+".amazonaws.com", "https://s3."+region+".amazonaws.com")
			} else {
				connect = append(connect, "https://*.amazonaws.com")
			}
		}
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'", // React style attributes (progress bars)
		"img-src 'self' data: blob:",
		"font-src 'self' data:", // small font files are embedded in the CSS by the build
		"connect-src " + strings.Join(connect, " "),
		"worker-src 'self' blob:",
		"media-src 'self' blob:",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
}

func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	csp := s.contentSecurityPolicy()
	prod := s.Cfg.Env == "prod"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// Customer files (PDFs, photos) open in the browser's own viewer, which a CSP would break.
		// They can only be allowed file types, and nosniff stops a browser treating them as anything else.
		if !strings.HasPrefix(r.URL.Path, "/api/v1/cd/files/") {
			h.Set("Content-Security-Policy", csp)
		}
		if prod {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// --- rate limits ------------------------------------------------------------------------

type limitRule struct {
	name      string
	perMinute int
	burst     int
	match     func(r *http.Request) bool
	shared    bool // counted in Server.SharedLimits when set (guessing and abuse guards)
}

const apiPrefix = "/api/v1/cd"

func pathIs(method, path string) func(*http.Request) bool {
	return func(r *http.Request) bool { return r.Method == method && r.URL.Path == apiPrefix+path }
}

// Per client IP. The first rule that matches applies; static files (the app itself) are never limited.
var limitRules = []limitRule{
	{"login", 10, 10, pathIs("POST", "/shop/login"), true},
	{"setup", 20, 10, func(r *http.Request) bool {
		return r.Method == "POST" && strings.HasPrefix(r.URL.Path, apiPrefix+"/shop/setup")
	}, true},
	{"staff-names", 30, 15, pathIs("GET", "/shop/staff-names"), true},
	{"create-job", 10, 6, func(r *http.Request) bool {
		return r.Method == "POST" && strings.HasPrefix(r.URL.Path, apiPrefix+"/shops/") && strings.HasSuffix(r.URL.Path, "/jobs")
	}, true},
	{"create-order", 10, 6, func(r *http.Request) bool {
		return r.Method == "POST" && strings.HasPrefix(r.URL.Path, apiPrefix+"/shops/") && strings.HasSuffix(r.URL.Path, "/orders")
	}, true},
	{"upload", 60, 30, func(r *http.Request) bool {
		return r.Method == "PUT" && strings.HasPrefix(r.URL.Path, apiPrefix+"/files/")
	}, false},
	{"events", 30, 10, func(r *http.Request) bool {
		return r.Method == "GET" && (strings.HasSuffix(r.URL.Path, "/events") || r.URL.Path == apiPrefix+"/ws")
	}, false},
	{"guest-write", 120, 60, func(r *http.Request) bool {
		return r.Method != "GET" && (strings.HasPrefix(r.URL.Path, apiPrefix+"/jobs/") || strings.HasPrefix(r.URL.Path, apiPrefix+"/orders/"))
	}, false},
	{"api", 600, 200, func(r *http.Request) bool { return strings.HasPrefix(r.URL.Path, "/api/") }, false},
}

// clientIP is the connecting address; or the CDN's viewer-address header (CD_CLIENT_IP_HEADER, e.g.
// CloudFront-Viewer-Address "ip:port"); or — behind a trusted proxy — the address that proxy saw
// (the last entry of X-Forwarded-For; earlier entries can be forged by the client).
func clientIP(r *http.Request, trustProxy bool, header string) string {
	if header != "" {
		if v := strings.TrimSpace(r.Header.Get(header)); v != "" {
			if ip := net.ParseIP(v); ip != nil {
				return ip.String()
			}
			// "ip:port"; IPv6 comes as "2001:db8::1:443", so split at the last colon.
			if i := strings.LastIndex(v, ":"); i > 0 {
				if ip := net.ParseIP(strings.Trim(v[:i], "[]")); ip != nil {
					return ip.String()
				}
			}
		}
	}
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(ip) != nil {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// allow applies one rule: shared rules use the shared store when there is one (fixed one-minute
// windows); if that store fails, the request is allowed and the in-memory bucket still applies.
func (s *Server) allow(r *http.Request, rule limitRule, ip string) (bool, time.Duration) {
	key := rule.name + "|" + ip
	if rule.shared && s.SharedLimits != nil {
		now := time.Now()
		n, err := s.SharedLimits.Hit(r.Context(), key, now)
		if err == nil {
			if n > rule.perMinute {
				return false, ratelimit.WindowStart(now).Add(ratelimit.Window).Sub(now)
			}
			return true, 0
		}
		s.Logger.Warn("shared rate limit unavailable; using this instance's limit", "rule", rule.name, "error", err)
	}
	return s.limiter.Allow(key, rule.perMinute, rule.burst)
}

// originCheck refuses requests that didn't come through the CDN (CD_ORIGIN_SECRET).
func (s *Server) originCheck(next http.Handler) http.Handler {
	secret := s.Cfg.OriginSecret
	if secret == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Origin-Verify")), []byte(secret)) != 1 {
			failCode(w, http.StatusForbidden, "forbidden", "Use the app's address.")
			return
		}
		r.Header.Del("X-Origin-Verify") // never echo or log it further down
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rateLimit(next http.Handler) http.Handler {
	if !s.Cfg.RateLimit {
		return next
	}
	if s.limiter == nil {
		s.limiter = ratelimit.New()
		go s.limiter.Run(time.Minute, nil)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		for _, rule := range limitRules {
			if !rule.match(r) {
				continue
			}
			ip := clientIP(r, s.Cfg.TrustProxy, s.Cfg.ClientIPHeader)
			ok, wait := s.allow(r, rule, ip)
			if !ok {
				secs := int(math.Ceil(wait.Seconds()))
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				s.Logger.Warn("rate limited", "rule", rule.name, "ip", ip, "path", r.URL.Path)
				failCode(w, http.StatusTooManyRequests, "rate_limited", fmt.Sprintf("Too many requests. Please wait %d seconds and try again.", secs))
				return
			}
			break
		}
		next.ServeHTTP(w, r)
	})
}
