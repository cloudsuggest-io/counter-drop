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

// Multi-day orders (blackbooks). Customers use the order's secret (X-Ticket-Secret), like tickets;
// staff use their session. Money is only recorded here — it changes hands at the counter.

type publicOrders struct {
	Enabled        bool                    `json:"enabled"`
	HardPaise      int64                   `json:"hardPaise"`
	SpiralPaise    int64                   `json:"spiralPaise"`
	SoftPaise      int64                   `json:"softPaise"`
	AdvancePercent int                     `json:"advancePercent"`
	FileDays       int                     `json:"fileDays"`
	Services       []domain.ServiceSetting `json:"services"` // only the ones the shop takes online
}

func toPublicOrders(o domain.OrderSettings) publicOrders {
	out := publicOrders{Enabled: o.Enabled, HardPaise: o.HardPaise, SpiralPaise: o.SpiralPaise, SoftPaise: o.SoftPaise,
		AdvancePercent: o.AdvancePercent, FileDays: store.OrderFileDays, Services: []domain.ServiceSetting{}}
	for _, s := range o.Normalise().Services {
		if s.Enabled {
			out.Services = append(out.Services, s)
		}
	}
	if len(out.Services) == 0 {
		out.Enabled = false
	}
	return out
}

// guestOrder wraps routes that need the order's secret.
func (s *Server) guestOrder(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.Store.VerifyOrderSecret(r.Context(), r.PathValue("id"), r.Header.Get("X-Ticket-Secret")); err != nil {
			s.fail(w, r, err)
			return
		}
		next(w, r)
	}
}

type orderView struct {
	Order      domain.Order `json:"order"`
	Balance    int64        `json:"balancePaise"`
	Shop       publicShop   `json:"shop"`
	ServerTime time.Time    `json:"serverTime"`
}

func (s *Server) respondOrder(w http.ResponseWriter, r *http.Request, o domain.Order, status int, extra map[string]any) {
	sh, err := s.Store.GetShopByID(r.Context(), o.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	wait, err := s.Store.Wait(r.Context(), sh.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v := orderView{Order: o, Balance: o.BalancePaise(), Shop: toPublic(sh, wait), ServerTime: time.Now().UTC()}
	if extra == nil {
		writeData(w, status, v)
		return
	}
	extra["view"] = v
	writeData(w, status, extra)
}

func (s *Server) publishOrder(o domain.Order) {
	if s.Hub == nil {
		return
	}
	s.Hub.Publish(realtime.OrderTopic(o.ID), realtime.Event{Type: "order.updated", Data: map[string]any{"id": o.ID, "state": o.State}})
	if o.State.Visible() {
		s.Hub.Publish(realtime.ShopTopic(o.ShopID), realtime.Event{Type: "orders.changed", Data: map[string]string{"orderId": o.ID}})
	}
}

func (s *Server) orderUploadTargets(r *http.Request, o domain.Order, in []newFileIn, skip map[string]bool) ([]uploadTarget, error) {
	out := []uploadTarget{} // always a list, even with no files (cards, "something else")
	i := 0
	for _, f := range o.Files {
		if skip[f.ID] || f.UploadStatus != domain.UploadStatusPending || f.DeletedAt != nil {
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

type newOrderIn struct {
	Service      string             `json:"service"`
	CustomerName string             `json:"customerName"`
	Phone        string             `json:"phone"`
	Spec         domain.OrderSpec   `json:"spec"`
	Cover        domain.CoverText   `json:"cover"`
	DueDate      string             `json:"dueDate"`
	Files        []newFileIn        `json:"files"`
	Lines        []domain.OrderLine `json:"lines"`        // counter orders only
	AdvancePaise int64              `json:"advancePaise"` // counter orders only
	Consent      bool               `json:"consent"`      // customer agreed to keep files until delivery
}

// POST /shops/{slug}/orders — the student starts an order (a draft until the files are uploaded).
func (s *Server) createOrder(w http.ResponseWriter, r *http.Request) {
	var body newOrderIn
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	if !body.Consent {
		failCode(w, 422, "validation", "Please agree to the shop keeping your files until delivery.")
		return
	}
	sh, err := s.Store.GetShopBySlug(r.Context(), r.PathValue("slug"))
	if err == nil && sh.Status != "live" {
		err = store.ErrNotFound
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	o, secret, err := s.Store.CreateOrder(r.Context(), sh, store.CreateOrderInput{
		Service: body.Service, Customer: body.CustomerName, Phone: body.Phone, Spec: body.Spec, Cover: body.Cover, DueDate: body.DueDate, Files: toNewFiles(body.Files),
	}, s.limits())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	uploads, err := s.orderUploadTargets(r, o, body.Files, nil)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondOrder(w, r, o, http.StatusCreated, map[string]any{"secret": secret, "uploads": uploads})
}

func (s *Server) getOrder(w http.ResponseWriter, r *http.Request) {
	o, err := s.Store.GetOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondOrder(w, r, o, 200, nil)
}

func (s *Server) addOrderFiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Files []newFileIn `json:"files"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	before, err := s.Store.GetOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	skip := map[string]bool{}
	for _, f := range before.Files {
		skip[f.ID] = true
	}
	o, err := s.Store.AddOrderFiles(r.Context(), before.ID, toNewFiles(body.Files), s.limits())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	uploads, err := s.orderUploadTargets(r, o, body.Files, skip)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondOrder(w, r, o, 200, map[string]any{"uploads": uploads})
}

func (s *Server) completeOrderFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pages int `json:"pages"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	o, err := s.Store.GetOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var f *domain.JobFile
	for i := range o.Files {
		if o.Files[i].ID == r.PathValue("fileId") {
			f = &o.Files[i]
		}
	}
	if f == nil || f.DeletedAt != nil {
		s.fail(w, r, store.ErrNotFound)
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
	o, err = s.Store.OrderFileUploaded(r.Context(), o.ID, f.ID, body.Pages)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishOrder(o)
	s.respondOrder(w, r, o, 200, nil)
}

// guestOrderStep wraps the simple customer actions that return the updated order.
func (s *Server) guestOrderStep(fn func(r *http.Request) (domain.Order, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		o, err := fn(r)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		s.publishOrder(o)
		s.respondOrder(w, r, o, 200, nil)
	}
}

func (s *Server) submitOrder(r *http.Request) (domain.Order, error) {
	return s.Store.SubmitOrder(r.Context(), r.PathValue("id"))
}

func (s *Server) approveOrderCover(r *http.Request) (domain.Order, error) {
	var body struct {
		Version int `json:"version"`
	}
	if err := decode(r, &body); err != nil {
		return domain.Order{}, err
	}
	return s.Store.ApproveOrderCover(r.Context(), r.PathValue("id"), body.Version)
}

func (s *Server) customerOrderCover(r *http.Request) (domain.Order, error) {
	var body domain.CoverText
	if err := decode(r, &body); err != nil {
		return domain.Order{}, err
	}
	return s.Store.CustomerOrderCover(r.Context(), r.PathValue("id"), body)
}

func (s *Server) cancelOrder(r *http.Request) (domain.Order, error) {
	return s.Store.CustomerCancelOrder(r.Context(), r.PathValue("id"))
}

func (s *Server) deleteOrderFiles(r *http.Request) (domain.Order, error) {
	return s.Store.DeleteOrderFiles(r.Context(), r.PathValue("id"))
}

// POST /orders/{id}/live (guest)
func (s *Server) orderLive(w http.ResponseWriter, r *http.Request) {
	writeData(w, 200, s.liveTicketFor(realtime.OrderTopic(r.PathValue("id"))))
}

// GET /orders/{id}/events?secret=… (guest SSE; EventSource can't send headers)
func (s *Server) orderEvents(w http.ResponseWriter, r *http.Request) {
	if s.NoSSE {
		failCode(w, http.StatusNotFound, "not_found", "Live updates use the WebSocket from POST …/live.")
		return
	}
	if err := s.Store.VerifyOrderSecret(r.Context(), r.PathValue("id"), r.URL.Query().Get("secret")); err != nil {
		s.fail(w, r, err)
		return
	}
	s.Hub.Serve(w, r, realtime.OrderTopic(r.PathValue("id")))
}

// --- shop side -----------------------------------------------------------------------------------

func (s *Server) shopOrders(w http.ResponseWriter, r *http.Request) {
	snap, err := s.Store.ShopOrders(r.Context(), principal(r.Context()).Staff.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, snap)
}

type shopOrderView struct {
	Order     domain.Order         `json:"order"`
	Balance   int64                `json:"balancePaise"`
	Suggested []domain.OrderLine   `json:"suggested"`
	Settings  domain.OrderSettings `json:"settings"`
	Service   domain.Service       `json:"service"` // the order's catalogue entry (form, proof, unit)
	// Secret is only present right after creating the order or asking for a new link.
	Secret     string    `json:"secret,omitempty"`
	ServerTime time.Time `json:"serverTime"`
}

func (s *Server) respondShopOrder(w http.ResponseWriter, r *http.Request, o domain.Order, secret string, status int) {
	sh, err := s.Store.GetShopByID(r.Context(), o.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, status, shopOrderView{Order: o, Balance: o.BalancePaise(), Suggested: domain.SuggestQuote(sh.Prices, sh.Orders, o.Service(), o.Spec),
		Settings: sh.Orders, Service: o.Service(), Secret: secret, ServerTime: time.Now().UTC()})
}

// POST /shop/orders — staff take an order at the counter.
func (s *Server) createShopOrder(w http.ResponseWriter, r *http.Request) {
	var body newOrderIn
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	p := principal(r.Context())
	sh, err := s.Store.GetShopByID(r.Context(), p.Staff.ShopID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	o, secret, err := s.Store.CreateOrder(r.Context(), sh, store.CreateOrderInput{
		Service: body.Service, Customer: body.CustomerName, Phone: body.Phone, Spec: body.Spec, Cover: body.Cover, DueDate: body.DueDate,
		Staff: p.Staff.Name, Lines: body.Lines, AdvancePaise: body.AdvancePaise,
	}, s.limits())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishOrder(o)
	s.respondShopOrder(w, r, o, secret, http.StatusCreated)
}

func (s *Server) shopOrder(w http.ResponseWriter, r *http.Request) {
	o, err := s.Store.OrderForShop(r.Context(), principal(r.Context()).Staff.ShopID, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondShopOrder(w, r, o, "", 200)
}

var orderActions = map[string]bool{"quote": true, "pay": true, "confirm": true, "stage": true, "deliver": true, "cancel": true,
	"cover": true, "details": true, "copies-deleted": true, "link": true}

func (s *Server) shopOrderAction(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	if !orderActions[action] {
		failCode(w, 404, "not_found", "Unknown action.")
		return
	}
	var body struct {
		Lines        []domain.OrderLine `json:"lines"`
		AdvancePaise int64              `json:"advancePaise"`
		Kind         string             `json:"kind"`
		Method       string             `json:"method"`
		Paise        int64              `json:"paise"`
		Stage        domain.OrderState  `json:"stage"`
		Reason       string             `json:"reason"`
		Cover        *domain.CoverText  `json:"cover"`
		Spec         *domain.OrderSpec  `json:"spec"`
		DueDate      string             `json:"dueDate"`
		CustomerName *string            `json:"customerName"`
		Phone        *string            `json:"phone"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &body); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	p := principal(r.Context())
	o, secret, err := s.Store.OrderAct(r.Context(), r.PathValue("id"), store.OrderActInput{
		Action: action, Staff: p.Staff.Name, ShopID: p.Staff.ShopID,
		Lines: body.Lines, AdvancePaise: body.AdvancePaise, PayKind: body.Kind, Method: body.Method, Paise: body.Paise,
		Stage: body.Stage, Reason: body.Reason, Cover: body.Cover, Spec: body.Spec, DueDate: body.DueDate,
		Customer: body.CustomerName, Phone: body.Phone,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publishOrder(o)
	s.respondShopOrder(w, r, o, secret, 200)
}

// GET /shop/orders/{id}/files/{fileId}/url — always a download; recorded and shown to the customer.
func (s *Server) orderFileURL(w http.ResponseWriter, r *http.Request) {
	p := principal(r.Context())
	o, f, err := s.Store.RecordOrderFileAccess(r.Context(), p.Staff.ShopID, r.PathValue("id"), r.PathValue("fileId"), p.Staff.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	url, err := s.Objects.PresignGet(r.Context(), f.ObjectKey, f.Filename, f.Mime, true)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.Logger.Info("order file downloaded", "order_id", o.ID, "file_id", f.ID, "staff_id", p.Staff.ID)
	s.publishOrder(o)
	writeData(w, 200, map[string]string{"url": url})
}

// PUT /shop/order-settings (owner)
func (s *Server) putOrderSettings(w http.ResponseWriter, r *http.Request) {
	var body domain.OrderSettings
	if err := decode(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.Store.UpdateOrderSettings(r.Context(), principal(r.Context()).Staff.ShopID, body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeData(w, 200, sh.Orders)
}
