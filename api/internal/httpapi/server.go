// Package httpapi exposes the Counter Drop REST API under /api/v1/cd.
package httpapi

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"counter-drop/api/internal/config"
	"counter-drop/api/internal/ratelimit"
	"counter-drop/api/internal/realtime"
	"counter-drop/api/internal/storage"
	"counter-drop/api/internal/store"
)

type Server struct {
	Store   store.Repository
	Objects storage.ObjectStore
	Local   *storage.LocalStore // non-nil when files are kept on local disk
	Hub     *realtime.Hub
	Logger  *slog.Logger
	Cfg     config.Config

	// SharedLimits, when set, keeps the sign-in, setup, staff-name and new-job limits in a store all
	// instances share (DynamoDB on Lambda). Other limits stay per instance.
	SharedLimits ratelimit.Shared
	// NoSSE turns off the Server-Sent Events endpoints (Lambda can't hold a stream open; clients use
	// the WebSocket from /live instead).
	NoSSE bool

	limiter *ratelimit.Limiter
}

func (s *Server) limits() store.Limits {
	return store.Limits{MaxFileBytes: s.Cfg.MaxFileBytes, MaxJobBytes: s.Cfg.MaxJobBytes, MaxFiles: s.Cfg.MaxFiles}
}

// Handler builds the full HTTP handler.
func (s *Server) Handler() http.Handler {
	if s.Cfg.Realtime.WSURL != "" && s.Cfg.Realtime.Key == "" {
		// Local mode signs and checks tickets in this one process, so a per-run key is enough.
		// On AWS the key must be shared with the WebSocket Lambda (cmd/api refuses to start without it).
		s.Cfg.Realtime.Key = store.NewSecret()
	}
	mux := http.NewServeMux()
	const p = "/api/v1/cd"

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeData(w, 200, map[string]any{"status": "ok", "time": time.Now().UTC()})
	})
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		if err := s.Store.Ping(r.Context()); err != nil {
			failCode(w, 503, "not_ready", "database unavailable")
			return
		}
		writeData(w, 200, map[string]any{"status": "ready"})
	})

	// Guest (customer) routes — upload only, pay at the counter.
	mux.HandleFunc("GET "+p+"/shops/{slug}", s.getShop)
	mux.HandleFunc("POST "+p+"/shops/{slug}/jobs", s.createJob)
	mux.HandleFunc("GET "+p+"/jobs/{id}", s.guest(s.getTicket))
	mux.HandleFunc("PATCH "+p+"/jobs/{id}", s.guest(s.updateJob))
	mux.HandleFunc("POST "+p+"/jobs/{id}/files", s.guest(s.addFiles))
	mux.HandleFunc("DELETE "+p+"/jobs/{id}/files/{fileId}", s.guest(s.removeFile))
	mux.HandleFunc("POST "+p+"/jobs/{id}/files/{fileId}/complete", s.guest(s.completeFile))
	mux.HandleFunc("POST "+p+"/jobs/{id}/submit", s.guest(s.submitJob))
	mux.HandleFunc("POST "+p+"/jobs/{id}/cancel", s.guest(s.cancelJob))
	mux.HandleFunc("POST "+p+"/jobs/{id}/delete-request", s.guest(s.requestDeletion))
	mux.HandleFunc("POST "+p+"/jobs/{id}/pay", s.guest(s.payJob))
	mux.HandleFunc("GET "+p+"/jobs/{id}/events", s.jobEvents)
	mux.HandleFunc("POST "+p+"/jobs/{id}/live", s.guest(s.jobLive))

	// Shop routes.
	mux.HandleFunc("GET "+p+"/shop/staff-names", s.staffNames)
	mux.HandleFunc("POST "+p+"/shop/login", s.login)
	mux.HandleFunc("POST "+p+"/shop/logout", s.staff(s.logout))
	mux.HandleFunc("GET "+p+"/shop/me", s.staff(s.me))
	mux.HandleFunc("PUT "+p+"/shop/me/pin", s.staff(s.changePIN))
	mux.HandleFunc("POST "+p+"/shop/setup/info", s.setupInfo)
	mux.HandleFunc("POST "+p+"/shop/setup", s.completeSetup)
	mux.HandleFunc("GET "+p+"/shop/staff", s.owner(s.listStaff))
	mux.HandleFunc("POST "+p+"/shop/staff", s.owner(s.inviteStaff))
	mux.HandleFunc("POST "+p+"/shop/staff/{id}/link", s.owner(s.staffLink))
	mux.HandleFunc("DELETE "+p+"/shop/staff/{id}", s.owner(s.removeStaff))
	mux.HandleFunc("GET "+p+"/shop/queue", s.staff(s.queue))
	mux.HandleFunc("POST "+p+"/shop/claim-next", s.staff(s.claimNext))
	mux.HandleFunc("POST "+p+"/shop/jobs/{id}/{action}", s.staff(s.jobAction))
	mux.HandleFunc("POST "+p+"/shop/jobs/{id}/copies-deleted", s.staff(s.copiesDeleted))
	mux.HandleFunc("GET "+p+"/shop/jobs/{id}/files/{fileId}/url", s.staff(s.fileURL))
	mux.HandleFunc("GET "+p+"/shop/lookup", s.staff(s.lookup))
	mux.HandleFunc("PUT "+p+"/shop/state", s.staff(s.setState))
	mux.HandleFunc("GET "+p+"/shop/settings", s.staff(s.getSettings))
	mux.HandleFunc("PUT "+p+"/shop/settings", s.owner(s.putSettings))
	mux.HandleFunc("GET "+p+"/shop/events", s.shopEvents)
	mux.HandleFunc("POST "+p+"/shop/live", s.staff(s.shopLive))
	if s.Cfg.Realtime.WSURL == "local" {
		mux.HandleFunc("GET "+p+"/ws", s.localWS)
	}
	mux.HandleFunc("GET "+p+"/shop/deletion-health", s.owner(s.deletionHealth))
	mux.HandleFunc("GET "+p+"/shop/dashboard", s.owner(s.dashboard))

	if s.Local != nil {
		mux.Handle(p+"/files/", s.Local.Handler())
	}

	var h http.Handler = mux
	if s.Cfg.WebDir != "" {
		h = spaFallback(s.Cfg.WebDir, mux)
	}
	// Order: recover → request ID → log → security headers → rate limit → CORS → routes.
	return chain(s.originCheck(s.securityHeaders(s.rateLimit(h))), s.Logger, s.Cfg.WebOrigins)
}

// spaFallback serves the built PWA for non-API paths, with index.html for client-side routes.
func spaFallback(dir string, api http.Handler) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/health" || r.URL.Path == "/ready" {
			api.ServeHTTP(w, r)
			return
		}
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			if strings.Contains(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}
