package httpapi

import (
	"context"
	"net/http"
	"strings"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/realtime"
	"counter-drop/api/internal/store"
)

type principalKey struct{}

func principal(ctx context.Context) store.Principal {
	p, _ := ctx.Value(principalKey{}).(store.Principal)
	return p
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// staff requires a signed-in staff session. The shop always comes from the session, never the request.
func (s *Server) staff(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Store.Session(r.Context(), bearer(r))
		if err != nil {
			s.fail(w, r, err)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	}
}

func (s *Server) owner(next http.HandlerFunc) http.HandlerFunc {
	return s.staff(func(w http.ResponseWriter, r *http.Request) {
		if principal(r.Context()).Staff.Role != "owner" {
			failCode(w, 403, "forbidden", "Only the shop owner can do this.")
			return
		}
		next(w, r)
	})
}

func actor(r *http.Request) domain.Actor {
	p := principal(r.Context())
	return domain.Actor{Type: domain.ActorStaff, ID: p.Staff.ID, Name: p.Staff.Name}
}

func (s *Server) staffNames(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("shop")
	sh, err := s.Store.GetShopBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	names, err := s.Store.StaffNames(r.Context(), slug)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, map[string]any{"shop": map[string]string{"slug": sh.Slug, "name": sh.Name}, "names": names})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Shop string `json:"shop"`
		Name string `json:"name"`
		PIN  string `json:"pin"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	token, p, err := s.Store.Login(r.Context(), body.Shop, body.Name, body.PIN, s.Cfg.SessionTTL)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.Store.GetShopByID(r.Context(), p.Staff.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, map[string]any{"token": token, "staff": p.Staff, "expiresAt": p.ExpiresAt, "shop": sh})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.Logout(r.Context(), bearer(r)); err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, map[string]bool{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	p := principal(r.Context())
	sh, err := s.Store.GetShopByID(r.Context(), p.Staff.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, map[string]any{"staff": p.Staff, "shop": sh, "expiresAt": p.ExpiresAt})
}

func (s *Server) queue(w http.ResponseWriter, r *http.Request) {
	q, err := s.Store.Queue(r.Context(), principal(r.Context()).Staff.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, q)
}

// dashboard returns the owner's summary for today (days=1, default), the last 7 or the last 30 days.
func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	days := 1
	switch r.URL.Query().Get("days") {
	case "7":
		days = 7
	case "30":
		days = 30
	}
	d, err := s.Store.Dashboard(r.Context(), principal(r.Context()).Staff.ShopID, days)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, d)
}

func (s *Server) claimNext(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Lane string `json:"lane"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	j, err := s.Store.ClaimNext(r.Context(), principal(r.Context()).Staff.ShopID, strings.ToUpper(body.Lane), actor(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishJob(j, "queue.changed")
	writeData(w, 200, j)
}

var staffActions = map[string]domain.Action{
	"claim": domain.ActionClaim, "release": domain.ActionRelease, "ready": domain.ActionReady,
	"collected": domain.ActionCollected, "undo": domain.ActionUndo, "cancel": domain.ActionCancel,
}

func (s *Server) jobAction(w http.ResponseWriter, r *http.Request) {
	action, ok := staffActions[r.PathValue("action")]
	if !ok {
		failCode(w, 404, "not_found", "Unknown action.")
		return
	}
	var body struct {
		Reason     string         `json:"reason"`
		Paid       string         `json:"paid"`
		OtherPrice *int64         `json:"otherPricePaise"` // ready: the shop's price for Other files
		Pages      map[string]int `json:"pages"`           // ready: page counts for documents (file ID → pages)
		NoReceipt  bool           `json:"noReceipt"`       // collected: don't give a receipt
	}
	if r.ContentLength != 0 {
		if err := decode(r, &body); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	j, err := s.Store.Act(r.Context(), r.PathValue("id"), store.ActInput{
		Action: action, Actor: actor(r), ShopID: principal(r.Context()).Staff.ShopID, Reason: body.Reason, Paid: body.Paid,
		OtherPrice: body.OtherPrice, Pages: body.Pages, NoReceipt: body.NoReceipt,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishJob(j, "queue.changed")
	writeData(w, 200, j)
}

// fileURL returns a short-lived link to a file. mode=print (default) opens it in the browser to print;
// mode=download saves it to the shop's device, and the customer is told straight away.
func (s *Server) fileURL(w http.ResponseWriter, r *http.Request) {
	p := principal(r.Context())
	f, err := s.Store.FileForShop(r.Context(), p.Staff.ShopID, r.PathValue("id"), r.PathValue("fileId"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Files the browser can't open itself (Word, Excel, HEIC…) can only be printed by downloading
	// them, so they are always handed out — and recorded — as downloads.
	download := r.URL.Query().Get("mode") == "download" || !domain.BrowserPrintable(f.Mime)
	url, err := s.Objects.PresignGet(r.Context(), f.ObjectKey, f.Filename, f.Mime, download)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	j, err := s.Store.RecordFileAccess(r.Context(), r.PathValue("id"), f.ID, p.Staff.Name, download)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.Logger.Info("file accessed", "job_id", j.ID, "file_id", f.ID, "staff_id", p.Staff.ID, "download", download)
	if download {
		s.Hub.Publish(realtime.JobTopic(j.ID), realtime.Event{Type: "file.downloaded", Data: map[string]any{"fileId": f.ID, "by": p.Staff.Name}})
		s.Hub.Publish(realtime.ShopTopic(j.ShopID), realtime.Event{Type: "queue.changed", Data: map[string]string{"jobId": j.ID}})
	}
	writeData(w, 200, map[string]string{"url": url})
}

// copiesDeleted: staff confirm they deleted the copies they downloaded.
func (s *Server) copiesDeleted(w http.ResponseWriter, r *http.Request) {
	p := principal(r.Context())
	j, err := s.Store.MarkCopiesDeleted(r.Context(), p.Staff.ShopID, r.PathValue("id"), p.Staff.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishJob(j, "queue.changed")
	writeData(w, 200, j)
}

func (s *Server) lookup(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.Store.Lookup(r.Context(), principal(r.Context()).Staff.ShopID, r.URL.Query().Get("q"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, jobs)
}

func (s *Server) setState(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State   domain.OnlineState `json:"state"`
		Message string             `json:"message"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.Store.SetShopState(r.Context(), principal(r.Context()).Staff.ShopID, body.State, body.Message)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.Hub.Publish(realtime.ShopTopic(sh.ID), realtime.Event{Type: "shop.state", Data: map[string]any{"onlineState": sh.OnlineState}})
	writeData(w, 200, sh)
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	sh, err := s.Store.GetShopByID(r.Context(), principal(r.Context()).Staff.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, sh)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Profile store.ShopProfile `json:"profile"`
		Prices  domain.PriceList  `json:"prices"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.Store.UpdateShopSettings(r.Context(), principal(r.Context()).Staff.ShopID, body.Profile, body.Prices)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, sh)
}

// shopEvents streams board updates. EventSource can't send headers, so the session token comes in ?token=.
func (s *Server) shopEvents(w http.ResponseWriter, r *http.Request) {
	if s.NoSSE {
		failCode(w, http.StatusNotFound, "not_found", "Live updates use the WebSocket from POST …/live.")
		return
	}
	p, err := s.Store.Session(r.Context(), r.URL.Query().Get("token"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.Hub.Serve(w, r, realtime.ShopTopic(p.Staff.ShopID))
}

func (s *Server) deletionHealth(w http.ResponseWriter, r *http.Request) {
	h, err := s.Store.DeletionHealth(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, h)
}
