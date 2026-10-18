package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// LocalStore keeps files on the API server's disk and serves them through signed URLs
// handled by the API itself. It exists so the MVP runs without R2/MinIO; use S3Store in production.
type LocalStore struct {
	dir     string
	baseURL string // public API origin, e.g. http://localhost:8080
	secret  []byte
	dur     Durations
	now     func() time.Time
}

const localPrefix = "/api/v1/cd/files/"

func NewLocalStore(dir, baseURL string, secret []byte, dur Durations) (*LocalStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if len(secret) < 16 {
		return nil, errors.New("local storage signing secret must be at least 16 bytes")
	}
	if dur.PutTTL == 0 {
		dur.PutTTL = 15 * time.Minute
	}
	if dur.GetTTL == 0 {
		dur.GetTTL = 5 * time.Minute
	}
	return &LocalStore{dir: dir, baseURL: strings.TrimRight(baseURL, "/"), secret: secret, dur: dur, now: time.Now}, nil
}

func (s *LocalStore) path(key string) (string, error) {
	clean := filepath.Clean("/" + key)
	if !strings.HasPrefix(clean, "/cd/") && !strings.HasPrefix(clean, "/ord/") {
		return "", fmt.Errorf("invalid key")
	}
	return filepath.Join(s.dir, clean), nil
}

func (s *LocalStore) sign(method, key string, exp int64, size int64, ctype string) string {
	m := hmac.New(sha256.New, s.secret)
	fmt.Fprintf(m, "%s\n%s\n%d\n%d\n%s", method, key, exp, size, ctype)
	return hex.EncodeToString(m.Sum(nil))
}

func (s *LocalStore) PresignPut(_ context.Context, key, contentType string, size int64) (string, map[string]string, error) {
	exp := s.now().Add(s.dur.PutTTL).Unix()
	q := url.Values{}
	q.Set("m", "PUT")
	q.Set("exp", strconv.FormatInt(exp, 10))
	q.Set("size", strconv.FormatInt(size, 10))
	q.Set("ct", contentType)
	q.Set("sig", s.sign("PUT", key, exp, size, contentType))
	return s.baseURL + localPrefix + key + "?" + q.Encode(), map[string]string{"Content-Type": contentType}, nil
}

func (s *LocalStore) PresignGet(_ context.Context, key, filename, contentType string, download bool) (string, error) {
	exp := s.now().Add(s.dur.GetTTL).Unix()
	disp := "inline"
	if download {
		disp = "attachment"
	}
	q := url.Values{}
	q.Set("m", "GET")
	q.Set("exp", strconv.FormatInt(exp, 10))
	q.Set("ct", contentType)
	q.Set("fn", filename)
	q.Set("d", disp)
	q.Set("sig", s.sign("GET", key, exp, 0, contentType+"\n"+disp))
	return s.baseURL + localPrefix + key + "?" + q.Encode(), nil
}

func (s *LocalStore) Head(_ context.Context, key string) (ObjectInfo, error) {
	p, err := s.path(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return ObjectInfo{}, ErrObjectNotFound
	}
	if err != nil {
		return ObjectInfo{}, err
	}
	ct, _ := os.ReadFile(p + ".type")
	return ObjectInfo{Size: st.Size(), ContentType: string(ct)}, nil
}

func (s *LocalStore) Delete(_ context.Context, key string) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	for _, f := range []string{p, p + ".type"} {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Handler serves signed PUT and GET requests under /api/v1/cd/files/{key...}.
func (s *LocalStore) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, localPrefix)
		q := r.URL.Query()
		exp, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
		if exp == 0 || s.now().Unix() > exp {
			http.Error(w, "link expired", http.StatusForbidden)
			return
		}
		p, err := s.path(key)
		if err != nil {
			http.Error(w, "bad key", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodPut:
			size, _ := strconv.ParseInt(q.Get("size"), 10, 64)
			ct := q.Get("ct")
			if q.Get("m") != "PUT" || !hmac.Equal([]byte(q.Get("sig")), []byte(s.sign("PUT", key, exp, size, ct))) {
				http.Error(w, "bad signature", http.StatusForbidden)
				return
			}
			if r.ContentLength != size || r.Header.Get("Content-Type") != ct {
				http.Error(w, "size or type does not match the signed upload", http.StatusForbidden)
				return
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
				http.Error(w, "storage error", http.StatusInternalServerError)
				return
			}
			tmp := p + ".part"
			f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				http.Error(w, "storage error", http.StatusInternalServerError)
				return
			}
			n, err := io.Copy(f, io.LimitReader(r.Body, size+1))
			f.Close()
			if err != nil || n != size {
				os.Remove(tmp)
				http.Error(w, "upload incomplete", http.StatusBadRequest)
				return
			}
			if err := os.Rename(tmp, p); err != nil {
				http.Error(w, "storage error", http.StatusInternalServerError)
				return
			}
			_ = os.WriteFile(p+".type", []byte(ct), 0o600)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet, http.MethodHead:
			ct := q.Get("ct")
			disp := q.Get("d")
			if disp != "attachment" {
				disp = "inline"
			}
			if q.Get("m") != "GET" || !hmac.Equal([]byte(q.Get("sig")), []byte(s.sign("GET", key, exp, 0, ct+"\n"+q.Get("d")))) {
				http.Error(w, "bad signature", http.StatusForbidden)
				return
			}
			f, err := os.Open(p)
			if err != nil {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			defer f.Close()
			st, _ := f.Stat()
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Content-Disposition", ContentDisposition(disp, q.Get("fn")))
			w.Header().Set("Cache-Control", "private, no-store")
			http.ServeContent(w, r, "", st.ModTime(), f)
		case http.MethodOptions:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
