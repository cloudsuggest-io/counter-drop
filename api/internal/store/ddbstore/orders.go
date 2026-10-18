package ddbstore

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Multi-day orders (blackbooks). Items:
//
//	O#<order>   ORDER              the order with its files and payments embedded
//	O#<order>   PAY#<ts>#<id>      one payment (for the dashboard, by day)
//
//	GSI1  S#<shop>#ORD       | <dueDate>#<createdAt>#<order>   open orders (sent, not delivered/cancelled)
//	GSI2  S#<shop>#P#<day>   | <ts>#<payment>                  payments by business day
//	GSI3  ORDDONE#<shop>     | <closedAt>#<order>              delivered or cancelled (history)
//	GSI4  ODUE               | <nextDue>#<order>               orders with a file scheduled for deletion
//
// Drafts (still uploading) carry a TTL so abandoned ones disappear on their own; their files are
// deleted by the worker after 24 hours like any other.

type orderRec struct {
	PK, SK string
	GSI1PK string `dynamodbav:",omitempty"`
	GSI1SK string `dynamodbav:",omitempty"`
	GSI3PK string `dynamodbav:",omitempty"`
	GSI3SK string `dynamodbav:",omitempty"`
	GSI4PK string `dynamodbav:",omitempty"`
	GSI4SK string `dynamodbav:",omitempty"`
	Type   string
	Ver    int64
	TTL    int64 `dynamodbav:"ttl,omitempty"`

	SecretHash string
	Order      domain.Order // Files is always empty here; they live in Files below
	Files      []fileRec
}

type payRec struct {
	PK, SK  string
	GSI2PK  string
	GSI2SK  string
	Type    string
	ShopID  string
	OrderID string
	Pay     domain.OrderPayment
}

func orderPK(id string) string { return "O#" + id }

const orderHistoryDays = 30

func (r *orderRec) file(id string) *fileRec {
	for i := range r.Files {
		if r.Files[i].F.ID == id {
			return &r.Files[i]
		}
	}
	return nil
}

func (r *orderRec) domainOrder() domain.Order {
	o := r.Order
	o.Files = []domain.JobFile{}
	files := append([]fileRec(nil), r.Files...)
	sort.SliceStable(files, func(a, b int) bool { return files[a].Seq < files[b].Seq })
	for _, f := range files {
		if f.RemovedAt != nil {
			continue
		}
		jf := f.F
		if jf.DeletedAt != nil {
			jf.Filename = ""
		}
		o.Files = append(o.Files, jf)
	}
	if o.Payments == nil {
		o.Payments = []domain.OrderPayment{}
	}
	if o.History == nil {
		o.History = []domain.OrderEvent{}
	}
	if o.Lines == nil {
		o.Lines = []domain.OrderLine{}
	}
	return o
}

func (r *orderRec) reindex() {
	o := r.Order
	r.GSI1PK, r.GSI1SK, r.GSI3PK, r.GSI3SK, r.GSI4PK, r.GSI4SK, r.TTL = "", "", "", "", "", "", 0
	switch {
	case o.State == domain.OrderDraft:
		r.TTL = ttlAfter(o.CreatedAt, 7*24*time.Hour)
	case o.State.Open():
		r.GSI1PK, r.GSI1SK = "S#"+o.ShopID+"#ORD", o.DueDate+"#"+ts(o.CreatedAt)+"#"+o.ID
	default:
		closed := o.UpdatedAt
		if o.DeliveredAt != nil {
			closed = *o.DeliveredAt
		} else if o.CancelledAt != nil {
			closed = *o.CancelledAt
		}
		r.GSI3PK, r.GSI3SK = "ORDDONE#"+o.ShopID, ts(closed)+"#"+o.ID
	}
	var best time.Time
	found := false
	for _, f := range r.Files {
		if f.F.DeletedAt != nil || f.F.DeleteAfter == nil {
			continue
		}
		at := *f.F.DeleteAfter
		if f.NextAttemptAt != nil && f.NextAttemptAt.After(at) {
			at = *f.NextAttemptAt
		}
		if !found || at.Before(best) {
			best, found = at, true
		}
	}
	if found {
		r.GSI4PK, r.GSI4SK = "ODUE", ts(best)+"#"+o.ID
	}
}

// scheduleFiles moves every live file's deletion to at (or keeps an earlier time).
func (r *orderRec) scheduleFiles(at time.Time) {
	for i := range r.Files {
		f := &r.Files[i]
		if f.F.DeletedAt != nil {
			continue
		}
		f.F.DeleteStatus = domain.DeleteStatusPending
		if f.F.DeleteAfter == nil || f.F.DeleteAfter.After(at) {
			t := at
			f.F.DeleteAfter = &t
		}
	}
}

func (r *orderRec) liveFiles() (size int64, count int) {
	for _, f := range r.Files {
		if f.RemovedAt == nil && f.F.DeletedAt == nil {
			size += f.F.Size
			count++
		}
	}
	return
}

// clearPersonal removes the customer's details once the order is closed and its files are gone
// (BR-D4 for orders). Amounts, dates and the code stay for the shop's records (BR-D5).
func (r *orderRec) clearPersonal() {
	o := &r.Order
	if o.State.Open() {
		return
	}
	for _, f := range r.Files {
		if f.F.DeletedAt == nil && f.RemovedAt == nil {
			return
		}
	}
	o.Customer, o.Phone, o.Cover = "", "", domain.CoverText{}
}

func (s *Store) loadOrder(ctx context.Context, id string) (*orderRec, error) {
	var r orderRec
	if err := s.get(ctx, orderPK(id), "ORDER", &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// mutateOrder is the order's read-modify-write with a version check (like mutateJob). Payments
// added by fn are written as their own items in the same transaction.
func (s *Store) mutateOrder(ctx context.Context, id string, fn func(r *orderRec, now time.Time) error) (*orderRec, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		r, err := s.loadOrder(ctx, id)
		if err != nil {
			return nil, err
		}
		old, paid := r.Ver, len(r.Order.Payments)
		now := s.now()
		if err := fn(r, now); err != nil {
			if errors.Is(err, errNoWrite) {
				return r, nil
			}
			return nil, err
		}
		r.clearPersonal()
		r.Ver++
		r.reindex()
		items := []types.TransactWriteItem{s.put(r, "#v = :v", map[string]string{"#v": "Ver"}, map[string]types.AttributeValue{":v": nv(old)})}
		if len(r.Order.Payments) > paid {
			sh, err := s.GetShopByID(ctx, r.Order.ShopID)
			if err != nil {
				return nil, err
			}
			for _, p := range r.Order.Payments[paid:] {
				items = append(items, s.put(payRec{
					PK: orderPK(r.Order.ID), SK: "PAY#" + ts(p.At) + "#" + p.ID, Type: "payment", ShopID: r.Order.ShopID, OrderID: r.Order.ID,
					GSI2PK: "S#" + r.Order.ShopID + "#P#" + domain.BusinessDay(p.At, sh.Location()), GSI2SK: ts(p.At) + "#" + p.ID, Pay: p,
				}, "", nil, nil))
			}
		}
		_, err = s.transact(ctx, items...)
		if errors.Is(err, errConflict) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return r, nil
	}
	return nil, errBusy
}

func (r *orderRec) addFiles(shopID string, files []store.NewFile, now time.Time) error {
	seq := 0
	for _, f := range r.Files {
		seq = max(seq, f.Seq)
	}
	for _, nf := range files {
		jf, err := store.NewOrderFile(shopID, r.Order.ID, nf, now)
		if err != nil {
			return err
		}
		if r.Order.SubmittedAt != nil { // adding to an order already sent: keep like the rest
			exp := r.Order.SubmittedAt.Add(store.OrderFileDays * 24 * time.Hour)
			jf.DeleteAfter = &exp
		}
		seq++
		r.Files = append(r.Files, fileRec{F: jf, Seq: seq, CreatedAt: now})
	}
	return nil
}

// --- customer side -------------------------------------------------------------------------------

func (s *Store) CreateOrder(ctx context.Context, sh domain.Shop, in store.CreateOrderInput, lim store.Limits) (domain.Order, string, error) {
	now := s.now()
	in, err := store.ValidateNewOrder(sh, in, lim, now)
	if err != nil {
		return domain.Order{}, "", err
	}
	secret := store.NewSecret()
	o := domain.Order{
		ID: store.NewID("ord"), ShopID: sh.ID, Code: store.OrderCode(), Kind: in.Service, State: domain.OrderDraft, Channel: "online",
		Customer: in.Customer, Phone: in.Phone, Spec: in.Spec, Cover: in.Cover, CoverVersion: 1, DueDate: in.DueDate,
		CreatedAt: now, UpdatedAt: now,
	}
	by := "customer"
	if in.Staff != "" {
		o.Channel, o.State, o.SubmittedAt, by = "counter", domain.OrderRequested, &now, in.Staff
	}
	o.History = []domain.OrderEvent{{At: now, Action: "created", By: by}}
	r := &orderRec{PK: orderPK(o.ID), SK: "ORDER", Type: "order", Ver: 1, SecretHash: store.HashSecret(secret), Order: o}
	if err := r.addFiles(sh.ID, in.Files, now); err != nil {
		return domain.Order{}, "", err
	}
	if in.Staff != "" && len(in.Lines) > 0 {
		if err := r.Order.SetQuote(in.Lines, in.AdvancePaise, now, in.Staff); err != nil {
			return domain.Order{}, "", err
		}
	}
	r.reindex()
	if _, err := s.transact(ctx, s.put(r, "attribute_not_exists(PK)", nil, nil)); err != nil {
		return domain.Order{}, "", err
	}
	return r.domainOrder(), secret, nil
}

func (s *Store) GetOrder(ctx context.Context, id string) (domain.Order, error) {
	r, err := s.loadOrder(ctx, id)
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

func (s *Store) VerifyOrderSecret(ctx context.Context, id, secret string) error {
	r, err := s.loadOrder(ctx, id)
	if err != nil {
		return err
	}
	if !store.EqualHash(secret, r.SecretHash) {
		return store.ErrBadSecret
	}
	return nil
}

func (s *Store) AddOrderFiles(ctx context.Context, id string, files []store.NewFile, lim store.Limits) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		if !r.Order.State.Open() || r.Order.State == domain.OrderReady {
			return domain.ErrOrderState
		}
		size, count := r.liveFiles()
		if err := store.ValidateFiles(files, lim, size, count); err != nil {
			return err
		}
		if err := r.addFiles(r.Order.ShopID, files, now); err != nil {
			return err
		}
		r.Order.UpdatedAt = now
		return nil
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

func (s *Store) OrderFileUploaded(ctx context.Context, id, fileID string, pages int) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		f := r.file(fileID)
		if f == nil || f.RemovedAt != nil || f.F.DeletedAt != nil {
			return store.ErrNotFound
		}
		p, status := store.UploadedPages(f.F.Mime, pages)
		f.F.UploadStatus, f.F.Pages, f.F.PagesStatus = domain.UploadStatusUploaded, p, status
		// Fill in the page count from the PDF when the student didn't give one.
		if r.Order.Spec.Pages == 0 && status == domain.PagesCounted && domain.FileKind(f.F.Mime) == "pdf" {
			r.Order.Spec.Pages = p
		}
		if r.Order.SubmittedAt != nil {
			r.Order.History = append(r.Order.History, domain.OrderEvent{At: now, Action: "file_added", By: "customer"})
		}
		r.Order.UpdatedAt = now
		return nil
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

// SubmitOrder sends a draft to the shop once every file has arrived.
func (s *Store) SubmitOrder(ctx context.Context, id string) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		if r.Order.State != domain.OrderDraft {
			return errNoWrite
		}
		n := 0
		for _, f := range r.Files {
			if f.RemovedAt != nil || f.F.DeletedAt != nil {
				continue
			}
			if f.F.UploadStatus != domain.UploadStatusUploaded {
				return fmt.Errorf("%w: wait for every file to finish uploading", domain.ErrValidation)
			}
			n++
		}
		if n == 0 && r.Order.Service().Form == domain.FormDocument {
			return fmt.Errorf("%w: add your file", domain.ErrValidation)
		}
		exp := now.Add(store.OrderFileDays * 24 * time.Hour)
		for i := range r.Files {
			if r.Files[i].F.DeletedAt == nil {
				r.Files[i].F.DeleteAfter = &exp
			}
		}
		r.Order.State, r.Order.SubmittedAt = domain.OrderRequested, &now
		r.Order.History = append(r.Order.History, domain.OrderEvent{At: now, Action: "sent", By: "customer"})
		r.Order.UpdatedAt = now
		return nil
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

// CustomerOrderCover lets the customer correct the proof (cover text or the words to print) until
// work passes the proof stage.
func (s *Store) CustomerOrderCover(ctx context.Context, id string, cover domain.CoverText) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		return r.Order.SetCover(cover, now, "customer")
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

func (s *Store) ApproveOrderCover(ctx context.Context, id string, version int) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		return r.Order.ApproveCover(version, now)
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

// CustomerCancelOrder: the student may cancel until money has changed hands.
func (s *Store) CustomerCancelOrder(ctx context.Context, id string) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		o := &r.Order
		if o.State != domain.OrderDraft && o.State != domain.OrderRequested && o.State != domain.OrderQuoted {
			return domain.ErrOrderState
		}
		if o.PaidPaise > 0 {
			return domain.ErrOrderState
		}
		if err := o.Cancel("customer_cancelled", "", now, "customer", ""); err != nil {
			return err
		}
		r.scheduleFiles(now)
		return nil
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

// DeleteOrderFiles: the student asks for their files to be deleted now (the order itself goes on).
// Allowed only until the shop starts work; after that they go automatically once printing is done.
func (s *Store) DeleteOrderFiles(ctx context.Context, id string) (domain.Order, error) {
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		if !store.StudentCanDeleteFiles(r.Order.State) {
			return domain.ErrOrderState
		}
		r.scheduleFiles(now)
		r.Order.History = append(r.Order.History, domain.OrderEvent{At: now, Action: "files_delete_requested", By: "customer"})
		r.Order.UpdatedAt = now
		return nil
	})
	if err != nil {
		return domain.Order{}, err
	}
	return r.domainOrder(), nil
}

// --- shop side -----------------------------------------------------------------------------------

func decodeOrders(dst *[]orderRec) func(map[string]types.AttributeValue) (bool, error) {
	return func(item map[string]types.AttributeValue) (bool, error) {
		var r orderRec
		if err := attributevalue.UnmarshalMap(item, &r); err != nil {
			return false, err
		}
		*dst = append(*dst, r)
		return true, nil
	}
}

func (s *Store) openOrders(ctx context.Context, shopID string) ([]orderRec, error) {
	var out []orderRec
	err := s.query(ctx, queryOpts{index: "GSI1", pk: "S#" + shopID + "#ORD"}, decodeOrders(&out))
	return out, err
}

func (s *Store) ShopOrders(ctx context.Context, shopID string) (store.OrdersSnapshot, error) {
	sh, err := s.GetShopByID(ctx, shopID)
	if err != nil {
		return store.OrdersSnapshot{}, err
	}
	now := s.now()
	open, err := s.openOrders(ctx, shopID)
	if err != nil {
		return store.OrdersSnapshot{}, err
	}
	var done []orderRec
	since := ts(now.Add(-orderHistoryDays * 24 * time.Hour))
	if err := s.query(ctx, queryOpts{index: "GSI3", pk: "ORDDONE#" + shopID, skOp: ">=", sk: since, descending: true, limit: 200}, decodeOrders(&done)); err != nil {
		return store.OrdersSnapshot{}, err
	}
	snap := store.OrdersSnapshot{Open: []domain.Order{}, Recent: []domain.Order{}, Settings: sh.Orders, ServerTime: now}
	for i := range open {
		snap.Open = append(snap.Open, open[i].domainOrder())
	}
	for i := range done {
		snap.Recent = append(snap.Recent, done[i].domainOrder())
	}
	return snap, nil
}

func (s *Store) OrderForShop(ctx context.Context, shopID, id string) (domain.Order, error) {
	r, err := s.loadOrder(ctx, id)
	if err != nil {
		return domain.Order{}, err
	}
	if r.Order.ShopID != shopID || !r.Order.State.Visible() {
		return domain.Order{}, store.ErrNotFound
	}
	return r.domainOrder(), nil
}

// OrderAct runs a staff action. For "link" it returns a fresh customer secret (the old link stops working).
func (s *Store) OrderAct(ctx context.Context, id string, in store.OrderActInput) (domain.Order, string, error) {
	var secret string
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		o := &r.Order
		if o.ShopID != in.ShopID || !o.State.Visible() {
			return store.ErrNotFound
		}
		switch in.Action {
		case "quote":
			return o.SetQuote(in.Lines, in.AdvancePaise, now, in.Staff)
		case "pay":
			return o.AddPayment(domain.OrderPayment{ID: store.NewID("pay"), Kind: in.PayKind, Method: in.Method, Paise: in.Paise, By: in.Staff}, now)
		case "confirm":
			return o.ConfirmWithoutAdvance(now, in.Staff)
		case "stage":
			if err := o.SetStage(in.Stage, now, in.Staff); err != nil {
				return err
			}
			// Printing is done once it goes to the binder (or straight to ready): keep the files one
			// more day for a reprint, then delete them. Moving back a step never extends this.
			if in.Stage == domain.OrderBinding || in.Stage == domain.OrderReady {
				r.scheduleFiles(now.Add(store.OrderReprintHours * time.Hour))
			}
			return nil
		case "deliver":
			if err := o.Deliver(in.Method, now, in.Staff, store.NewID("pay")); err != nil {
				return err
			}
			r.scheduleFiles(now)
			return nil
		case "cancel":
			if err := o.Cancel(in.Reason, in.Method, now, in.Staff, store.NewID("pay")); err != nil {
				return err
			}
			r.scheduleFiles(now)
			return nil
		case "cover":
			if in.Cover == nil {
				return fmt.Errorf("%w: cover text missing", domain.ErrValidation)
			}
			return o.SetCover(*in.Cover, now, in.Staff)
		case "details":
			return s.orderDetails(ctx, o, in, now)
		case "copies-deleted":
			if !o.Downloaded() {
				return errNoWrite
			}
			o.CopiesDeletedAt, o.CopiesDeletedBy = &now, in.Staff
			o.History = append(o.History, domain.OrderEvent{At: now, Action: "copies_deleted", By: in.Staff})
			o.UpdatedAt = now
			return nil
		case "link":
			if !o.State.Open() {
				return domain.ErrOrderState
			}
			secret = store.NewSecret()
			r.SecretHash = store.HashSecret(secret)
			o.UpdatedAt = now
			return nil
		}
		return store.ErrNotFound
	})
	if err != nil {
		return domain.Order{}, "", err
	}
	return r.domainOrder(), secret, nil
}

func (s *Store) orderDetails(ctx context.Context, o *domain.Order, in store.OrderActInput, now time.Time) error {
	if !o.State.Open() {
		return domain.ErrOrderState
	}
	if in.Customer != nil {
		n, err := store.OrderName(*in.Customer)
		if err != nil {
			return err
		}
		o.Customer = n
	}
	if in.Phone != nil {
		p, err := store.ValidPhone(*in.Phone)
		if err != nil {
			return err
		}
		o.Phone = p
	}
	if in.Spec != nil {
		sp, err := in.Spec.Validate(o.Service())
		if err != nil {
			return err
		}
		o.Spec = sp
	}
	if in.DueDate != "" && in.DueDate != o.DueDate {
		sh, err := s.GetShopByID(ctx, o.ShopID)
		if err != nil {
			return err
		}
		if err := domain.ValidDueDate(in.DueDate, now, sh.Location(), 0); err != nil {
			return err
		}
		o.History = append(o.History, domain.OrderEvent{At: now, Action: "due_changed", By: in.Staff, Note: in.DueDate})
		o.DueDate = in.DueDate
	}
	o.UpdatedAt = now
	return nil
}

// RecordOrderFileAccess hands a file to staff. Order files are always downloaded (they're opened in
// Word or edited over days), so every access is recorded and shown to the customer.
func (s *Store) RecordOrderFileAccess(ctx context.Context, shopID, id, fileID, staffName string) (domain.Order, domain.JobFile, error) {
	var out domain.JobFile
	r, err := s.mutateOrder(ctx, id, func(r *orderRec, now time.Time) error {
		if r.Order.ShopID != shopID || !r.Order.State.Visible() {
			return store.ErrNotFound
		}
		f := r.file(fileID)
		if f == nil || f.RemovedAt != nil || f.F.DeletedAt != nil || f.F.UploadStatus != domain.UploadStatusUploaded {
			return store.ErrNotFound
		}
		f.F.Downloads++
		if f.F.DownloadedAt == nil {
			f.F.DownloadedAt = &now
		}
		if f.F.DownloadedBy == "" {
			f.F.DownloadedBy = staffName
		}
		r.Order.CopiesDeletedAt, r.Order.CopiesDeletedBy = nil, ""
		r.Order.UpdatedAt = now
		out = f.F
		return nil
	})
	if err != nil {
		return domain.Order{}, domain.JobFile{}, err
	}
	return r.domainOrder(), out, nil
}

func (s *Store) UpdateOrderSettings(ctx context.Context, shopID string, os domain.OrderSettings) (domain.Shop, error) {
	if err := os.Validate(); err != nil {
		return domain.Shop{}, err
	}
	return s.mutateShop(ctx, shopID, func(r *shopRec) error {
		r.Shop.Orders = os
		return nil
	})
}

// --- deletion worker -----------------------------------------------------------------------------

func (s *Store) dueOrders(ctx context.Context, t time.Time) ([]orderRec, error) {
	var out []orderRec
	o := queryOpts{index: "GSI4", pk: "ODUE"}
	if !t.IsZero() {
		o.skOp, o.sk = "<", ts(t)+"$"
	}
	err := s.query(ctx, o, decodeOrders(&out))
	return out, err
}

func (s *Store) markOrderFileDeleted(ctx context.Context, due store.DueFile) (string, bool, error) {
	done := false
	r, err := s.mutateOrder(ctx, due.OrderID, func(r *orderRec, now time.Time) error {
		f := r.file(due.ID)
		if f == nil {
			return store.ErrNotFound
		}
		f.F.DeleteStatus, f.F.DeletedAt, f.F.ObjectKey, f.F.Filename, f.LastDeleteError = domain.DeleteStatusDeleted, &now, "", "", ""
		remaining := 0
		for _, x := range r.Files {
			if x.F.DeletedAt == nil {
				remaining++
			}
		}
		done = remaining == 0
		if done && r.Order.FilesDeletedAt == nil {
			r.Order.FilesDeletedAt = &now
			r.Order.History = append(r.Order.History, domain.OrderEvent{At: now, Action: "files_deleted"})
		}
		r.Order.UpdatedAt = now
		return nil
	})
	if err != nil {
		return "", false, err
	}
	s.countDeleted(ctx)
	return r.Order.ShopID, done, nil
}

func (s *Store) markOrderFileFailed(ctx context.Context, due store.DueFile, cause error) (int, error) {
	attempts := 0
	_, err := s.mutateOrder(ctx, due.OrderID, func(r *orderRec, now time.Time) error {
		f := r.file(due.ID)
		if f == nil {
			return store.ErrNotFound
		}
		msg := cause.Error()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		f.DeleteAttempts++
		attempts = f.DeleteAttempts
		next := now.Add(store.DeleteBackoff(attempts))
		f.F.DeleteStatus, f.LastDeleteError, f.NextAttemptAt = domain.DeleteStatusFailed, msg, &next
		return nil
	})
	return attempts, err
}

// orderPayments returns the payments recorded on the given business days.
func (s *Store) orderPayments(ctx context.Context, shopID string, days ...string) ([]store.OrderPaymentRow, error) {
	var out []store.OrderPaymentRow
	for _, d := range days {
		err := s.query(ctx, queryOpts{index: "GSI2", pk: "S#" + shopID + "#P#" + d}, func(item map[string]types.AttributeValue) (bool, error) {
			var p payRec
			if err := attributevalue.UnmarshalMap(item, &p); err != nil {
				return false, err
			}
			out = append(out, store.OrderPaymentRow{OrderID: p.OrderID, Kind: p.Pay.Kind, Method: p.Pay.Method, Paise: p.Pay.Paise, At: p.Pay.At, By: p.Pay.By})
			return true, nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
