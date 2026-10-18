package httpapi

import (
	"errors"
	"net/http"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/realtime"
	"counter-drop/api/internal/storage"
	"counter-drop/api/internal/store"
)

type publicShop struct {
	ID              string              `json:"id"`
	Slug            string              `json:"slug"`
	Name            string              `json:"name"`
	Address         string              `json:"address"`
	OnlineState     domain.OnlineState  `json:"onlineState"`
	PauseMessage    string              `json:"pauseMessage,omitempty"`
	IsOpen          bool                `json:"isOpen"`
	OpensAt         string              `json:"opensAt"`
	ClosesAt        string              `json:"closesAt"`
	Prices          domain.PriceList    `json:"prices"`
	ColourAvailable bool                `json:"colourAvailable"`
	Wait            domain.WaitEstimate `json:"wait"`
	HoldDays        int                 `json:"holdDays"`
	Orders          publicOrders        `json:"orders"`
}

func toPublic(sh domain.Shop, wait domain.WaitEstimate) publicShop {
	return publicShop{ID: sh.ID, Slug: sh.Slug, Name: sh.Name, Address: sh.Address, OnlineState: sh.OnlineState,
		PauseMessage: sh.PauseMessage, IsOpen: sh.IsOpen(time.Now()), OpensAt: sh.OpensAt, ClosesAt: sh.ClosesAt,
		Prices: sh.Prices, ColourAvailable: sh.Prices.ColourAvailable(), Wait: wait, HoldDays: sh.HoldDays, Orders: toPublicOrders(sh.Orders)}
}

func (s *Server) getShop(w http.ResponseWriter, r *http.Request) {
	sh, err := s.Store.GetShopBySlug(r.Context(), r.PathValue("slug"))
	if err == nil && sh.Status != "live" {
		err = store.ErrNotFound
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	wait, err := s.Store.Wait(r.Context(), sh.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, toPublic(sh, wait))
}

// guest wraps routes that need the ticket secret (header X-Ticket-Secret).
func (s *Server) guest(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.Store.VerifySecret(r.Context(), r.PathValue("id"), r.Header.Get("X-Ticket-Secret")); err != nil {
			s.fail(w, r, err)
			return
		}
		next(w, r)
	}
}

type ticket struct {
	Job        domain.Job    `json:"job"`
	Quote      *domain.Quote `json:"quote,omitempty"`
	Position   int           `json:"position"`
	Shop       publicShop    `json:"shop"`
	UndoUntil  *time.Time    `json:"undoUntil,omitempty"` // files deleted at/after this
	HoldUntil  *time.Time    `json:"holdUntil,omitempty"` // collect by: an uncollected job closes after this
	ServerTime time.Time     `json:"serverTime"`
}

func (s *Server) ticketFor(r *http.Request, j domain.Job) (ticket, error) {
	sh, err := s.Store.GetShopByID(r.Context(), j.ShopID)
	if err != nil {
		return ticket{}, err
	}
	wait, err := s.Store.Wait(r.Context(), sh.ID)
	if err != nil {
		return ticket{}, err
	}
	t := ticket{Job: j, Shop: toPublic(sh, wait), ServerTime: time.Now().UTC()}
	if q, err := store.QuoteFor(sh, j); err == nil {
		t.Quote = &q
	}
	if t.Position, err = s.Store.Position(r.Context(), j); err != nil {
		return ticket{}, err
	}
	if j.State == domain.JobStateCollected && j.CollectedAt != nil {
		u := j.CollectedAt.Add(s.Cfg.UndoWindow)
		if j.CopiesDeleteRequestedAt != nil && j.CopiesDeleteRequestedAt.Before(u) {
			u = *j.CopiesDeleteRequestedAt
		}
		t.UndoUntil = &u
	}
	if (j.State == domain.JobStateQueued || j.State == domain.JobStateClaimed || j.State == domain.JobStateReady) && j.QueuedAt != nil {
		h := j.QueuedAt.Add(time.Duration(sh.HoldDays) * 24 * time.Hour)
		t.HoldUntil = &h
	}
	return t, nil
}

func (s *Server) respondTicket(w http.ResponseWriter, r *http.Request, j domain.Job, status int) {
	t, err := s.ticketFor(r, j)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, status, t)
}

type uploadTarget struct {
	FileID   string            `json:"fileId"`
	ClientID string            `json:"clientId"`
	URL      string            `json:"url"`
	Method   string            `json:"method"`
	Headers  map[string]string `json:"headers"`
}

type newFileIn struct {
	ClientID string `json:"clientId"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
}

func (s *Server) uploadTargets(r *http.Request, j domain.Job, in []newFileIn, skip map[string]bool) ([]uploadTarget, error) {
	var out []uploadTarget
	i := 0
	for _, f := range j.Files {
		if skip[f.ID] || f.UploadStatus != domain.UploadStatusPending || f.DeleteStatus != domain.DeleteStatusActive {
			continue
		}
		url, headers, err := s.Objects.PresignPut(r.Context(), f.ObjectKey, f.Mime, f.Size)
		if err != nil {
			return nil, err
		}
		cid := ""
		if i < len(in) {
			cid = in[i].ClientID
		}
		i++
		out = append(out, uploadTarget{FileID: f.ID, ClientID: cid, URL: url, Method: http.MethodPut, Headers: headers})
	}
	return out, nil
}

func toNewFiles(in []newFileIn) []store.NewFile {
	out := make([]store.NewFile, len(in))
	for i, f := range in {
		out[i] = store.NewFile{Filename: f.Filename, Size: f.Size, Mime: f.Mime}
	}
	return out
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CustomerName string      `json:"customerName"`
		Files        []newFileIn `json:"files"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.Store.GetShopBySlug(r.Context(), r.PathValue("slug"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	j, secret, err := s.Store.CreateJob(r.Context(), sh, store.CreateJobInput{CustomerName: body.CustomerName, Files: toNewFiles(body.Files)}, s.limits())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	uploads, err := s.uploadTargets(r, j, body.Files, nil)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	t, err := s.ticketFor(r, j)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, http.StatusCreated, map[string]any{"ticket": t, "secret": secret, "uploads": uploads})
}

func (s *Server) addFiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Files []newFileIn `json:"files"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	before, err := s.Store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	skip := map[string]bool{}
	for _, f := range before.Files {
		skip[f.ID] = true
	}
	j, err := s.Store.AddFiles(r.Context(), before.ID, toNewFiles(body.Files), s.limits())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	uploads, err := s.uploadTargets(r, j, body.Files, skip)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	t, err := s.ticketFor(r, j)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, map[string]any{"ticket": t, "uploads": uploads})
}

func (s *Server) removeFile(w http.ResponseWriter, r *http.Request) {
	j, err := s.Store.RemoveFile(r.Context(), r.PathValue("id"), r.PathValue("fileId"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondTicket(w, r, j, 200)
}

// completeFile verifies the object really exists with the declared size, then records the page count.
func (s *Server) completeFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pages int `json:"pages"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	_, f, err := s.Store.FileForGuest(r.Context(), r.PathValue("id"), r.PathValue("fileId"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	info, err := s.Objects.Head(r.Context(), f.ObjectKey)
	if errors.Is(err, storage.ErrObjectNotFound) {
		failCode(w, 409, "upload_missing", "We didn't receive this file. Please try again.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if info.Size != f.Size {
		_ = s.Objects.Delete(r.Context(), f.ObjectKey)
		failCode(w, 422, "upload_mismatch", "The uploaded file didn't match. Please upload it again.")
		return
	}
	if _, err := s.Store.FileUploaded(r.Context(), r.PathValue("id"), f.ID, body.Pages); err != nil {
		s.fail(w, r, err)
		return
	}
	j, err := s.Store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondTicket(w, r, j, 200)
}

func (s *Server) getTicket(w http.ResponseWriter, r *http.Request) {
	j, err := s.Store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondTicket(w, r, j, 200)
}

func (s *Server) updateJob(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CustomerName *string                    `json:"customerName"`
		Files        []store.FileSettingsUpdate `json:"files"`
		ApplyToAll   *domain.FileSettings       `json:"applyToAll"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	files := body.Files
	if body.ApplyToAll != nil {
		cur, err := s.Store.GetJob(r.Context(), r.PathValue("id"))
		if err != nil {
			s.fail(w, r, err)
			return
		}
		files = nil
		for _, f := range cur.Files {
			// Print options apply to printed files; files sent as Other keep their own settings.
			if f.DeleteStatus == domain.DeleteStatusActive && !f.Settings.Other {
				st := *body.ApplyToAll
				st.Other, st.Note = false, ""
				st.PageRange = f.Settings.PageRange
				files = append(files, store.FileSettingsUpdate{FileID: f.ID, Settings: st})
			}
		}
	}
	j, err := s.Store.UpdateJob(r.Context(), r.PathValue("id"), body.CustomerName, files)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if j.State != domain.JobStateUploading {
		s.publishJob(j, "queue.changed")
	}
	s.respondTicket(w, r, j, 200)
}

func (s *Server) submitJob(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PriceVersion string `json:"priceVersion"`
		CustomerName string `json:"customerName"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	j, _, err := s.Store.Submit(r.Context(), r.PathValue("id"), body.PriceVersion, body.CustomerName)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishJob(j, "queue.job_added")
	s.respondTicket(w, r, j, 200)
}

// requestDeletion: after pickup the customer asks for their files to be deleted (ours now, the shop's downloads next).
func (s *Server) requestDeletion(w http.ResponseWriter, r *http.Request) {
	j, err := s.Store.RequestCopiesDeletion(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishJob(j, "queue.changed")
	s.respondTicket(w, r, j, 200)
}

func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	j, err := s.Store.Act(r.Context(), r.PathValue("id"), store.ActInput{Action: domain.ActionCancel, Actor: domain.Actor{Type: domain.ActorGuest, Name: "customer"}, Reason: "customer_cancelled"})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishJob(j, "queue.changed")
	s.respondTicket(w, r, j, 200)
}

// payJob enforces the upload-only rule: walk-in jobs are paid at the counter (FS-5.0.2).
func (s *Server) payJob(w http.ResponseWriter, r *http.Request) {
	failCode(w, 409, "pay_not_allowed", "Walk-in jobs are paid at the counter.")
}

func (s *Server) jobEvents(w http.ResponseWriter, r *http.Request) {
	if s.NoSSE {
		failCode(w, http.StatusNotFound, "not_found", "Live updates use the WebSocket from POST …/live.")
		return
	}
	id := r.PathValue("id")
	if err := s.Store.VerifySecret(r.Context(), id, r.URL.Query().Get("secret")); err != nil {
		s.fail(w, r, err)
		return
	}
	s.Hub.Serve(w, r, realtime.JobTopic(id))
}

// publishJob notifies the job's ticket page and its shop board.
func (s *Server) publishJob(j domain.Job, shopEvent string) {
	s.Hub.Publish(realtime.JobTopic(j.ID), realtime.Event{Type: "job.updated", Data: map[string]any{"state": j.State, "id": j.ID}})
	s.Hub.Publish(realtime.ShopTopic(j.ShopID), realtime.Event{Type: shopEvent, Data: map[string]string{"jobId": j.ID, "token": j.Token}})
}
