package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"
)

type orderViewT struct {
	Order   domain.Order `json:"order"`
	Balance int64        `json:"balancePaise"`
}

type shopOrderT struct {
	Order     domain.Order       `json:"order"`
	Balance   int64              `json:"balancePaise"`
	Suggested []domain.OrderLine `json:"suggested"`
	Secret    string             `json:"secret"`
}

var blackbookCover = map[string]any{"title": "A Study of UPI Adoption in Small Shops", "student": "Riya Shah", "rollNo": "42",
	"course": "T.Y.B.Com", "college": "R.A. Podar College", "guide": "Prof. Kulkarni", "year": "2026-27", "spine": "Riya Shah · UPI"}

// The full blackbook flow: the student sends the project online, the shop quotes, takes an advance,
// the student approves the cover text, the shop prints and binds, and collects the balance on delivery.
// Money shows in the dashboard on the day it was paid; files and personal details go after delivery.
func TestBlackbookOrderFlow(t *testing.T) {
	e := setup(t)
	newOrder := map[string]any{
		"service": "blackbook", "customerName": "Riya", "phone": "98200 12345", "dueDate": "2026-10-06", "consent": true,
		"spec":  map[string]any{"copies": 3, "binding": "hard", "colourPages": "1-4", "notes": "Certificate page in colour"},
		"cover": blackbookCover,
		"files": []map[string]any{{"clientId": "a", "filename": "Blackbook final.docx", "size": 300, "mime": docxMime},
			{"clientId": "b", "filename": "Blackbook final.pdf", "size": 310, "mime": "application/pdf"}},
	}
	// Consent, lead time and a valid phone are required.
	bad := map[string]any{}
	for k, v := range newOrder {
		bad[k] = v
	}
	bad["consent"] = false
	if r := e.do("POST", "/api/v1/cd/shops/demo-print/orders", bad, nil); r.Status != 422 {
		t.Fatalf("no consent: %d", r.Status)
	}
	bad["consent"], bad["dueDate"] = true, "2026-10-02"
	if r := e.do("POST", "/api/v1/cd/shops/demo-print/orders", bad, nil); r.Status != 422 {
		t.Fatalf("too soon: %d", r.Status)
	}
	bad["dueDate"], bad["phone"] = "2026-10-06", "12345"
	if r := e.do("POST", "/api/v1/cd/shops/demo-print/orders", bad, nil); r.Status != 422 {
		t.Fatalf("bad phone: %d", r.Status)
	}

	created := must[struct {
		View    orderViewT `json:"view"`
		Secret  string     `json:"secret"`
		Uploads []upload   `json:"uploads"`
	}](t, e.do("POST", "/api/v1/cd/shops/demo-print/orders", newOrder, nil), 201)
	o := created.View.Order
	h := map[string]string{"X-Ticket-Secret": created.Secret}
	path := "/api/v1/cd/orders/" + o.ID
	if o.State != domain.OrderDraft || o.Phone != "9820012345" || len(created.Uploads) != 2 || o.Code == "" {
		t.Fatalf("created: %+v", o)
	}
	if r := e.do("GET", path, nil, map[string]string{"X-Ticket-Secret": "nope"}); r.Status == 200 {
		t.Fatal("wrong secret accepted")
	}
	staff := e.login("Kavita", "1111")
	if snap := must[store.OrdersSnapshot](t, e.do("GET", "/api/v1/cd/shop/orders", nil, staff), 200); len(snap.Open) != 0 {
		t.Fatal("draft visible to the shop")
	}
	if r := e.do("POST", path+"/submit", nil, h); r.Status != 422 {
		t.Fatalf("submit before upload: %d", r.Status)
	}
	for i, u := range created.Uploads {
		req, _ := http.NewRequest("PUT", u.URL, bytes.NewReader(bytes.Repeat([]byte("x"), 300+10*i)))
		for k, v := range u.Headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("PUT: %v", err)
		}
		res.Body.Close()
		pages := 0
		if i == 1 {
			pages = 80
		}
		must[orderViewT](t, e.do("POST", path+"/files/"+u.FileID+"/complete", map[string]int{"pages": pages}, h), 200)
	}
	sent := must[orderViewT](t, e.do("POST", path+"/submit", nil, h), 200).Order
	if sent.State != domain.OrderRequested || sent.Spec.Pages != 80 {
		t.Fatalf("sent: %s pages %d", sent.State, sent.Spec.Pages)
	}
	// Once sent, files are kept at most 7 days (time for the shop to see it, quote and start).
	for _, f := range sent.Files {
		if f.DeleteAfter == nil || !f.DeleteAfter.Equal(sent.SubmittedAt.Add(store.OrderFileDays*24*time.Hour)) {
			t.Fatalf("sent file kept until %v", f.DeleteAfter)
		}
	}

	// The shop sees it, with a suggested quote from its prices: 76 B/W × 3 at ₹2, 4 colour × 3 at ₹10,
	// hard binding ₹250 × 3 = ₹1,326.
	snap := must[store.OrdersSnapshot](t, e.do("GET", "/api/v1/cd/shop/orders", nil, staff), 200)
	if len(snap.Open) != 1 || snap.Open[0].ID != o.ID || !snap.Settings.Enabled {
		t.Fatalf("open orders: %+v", snap.Open)
	}
	so := must[shopOrderT](t, e.do("GET", "/api/v1/cd/shop/orders/"+o.ID, nil, staff), 200)
	var total int64
	for _, l := range so.Suggested {
		total += l.Paise
	}
	if total != 132600 || len(so.Suggested) != 3 {
		t.Fatalf("suggested: %+v", so.Suggested)
	}
	act := func(action string, body any) resp {
		return e.do("POST", "/api/v1/cd/shop/orders/"+o.ID+"/"+action, body, staff)
	}
	if r := act("pay", map[string]any{"kind": "advance", "method": "cash", "paise": 50000}); r.Status != 422 {
		t.Fatalf("pay before quote: %d", r.Status)
	}
	lines := append(so.Suggested, domain.OrderLine{Label: "CD pocket", Paise: 2400})
	q := must[shopOrderT](t, act("quote", map[string]any{"lines": lines, "advancePaise": 70000}), 200)
	if q.Order.State != domain.OrderQuoted || q.Order.TotalPaise != 135000 || q.Balance != 135000 {
		t.Fatalf("quote: %+v", q.Order)
	}
	if v := must[orderViewT](t, e.do("GET", path, nil, h), 200); v.Order.TotalPaise != 135000 || v.Order.AdvancePaise != 70000 {
		t.Fatalf("customer sees quote: %+v", v.Order)
	}
	if r := act("pay", map[string]any{"kind": "advance", "method": "cash", "paise": 200000}); r.Status != 422 {
		t.Fatalf("overpay: %d", r.Status)
	}
	adv := must[shopOrderT](t, act("pay", map[string]any{"kind": "advance", "method": "cash", "paise": 70000}), 200)
	if adv.Order.State != domain.OrderConfirmed || adv.Balance != 65000 {
		t.Fatalf("advance: %s %d", adv.Order.State, adv.Balance)
	}

	// Binding waits for the student's OK on the cover text.
	must[shopOrderT](t, act("stage", map[string]any{"stage": "printing"}), 200)
	if r := act("stage", map[string]any{"stage": "binding"}); r.Status != 422 || r.Error.Code != "cover_required" {
		t.Fatalf("binding without approval: %d %+v", r.Status, r.Error)
	}
	cur := must[orderViewT](t, e.do("GET", path, nil, h), 200).Order
	fixed := map[string]any{}
	for k, v := range blackbookCover {
		fixed[k] = v
	}
	fixed["student"] = "Riya M. Shah"
	edited := must[orderViewT](t, e.do("PUT", path+"/cover", fixed, h), 200).Order
	if edited.CoverVersion != cur.CoverVersion+1 || edited.Cover.Student != "Riya M. Shah" {
		t.Fatalf("customer cover edit: %+v", edited.Cover)
	}
	if r := e.do("POST", path+"/approve-cover", map[string]int{"version": cur.CoverVersion}, h); r.Status != 422 {
		t.Fatalf("stale approval: %d", r.Status)
	}
	if ap := must[orderViewT](t, e.do("POST", path+"/approve-cover", map[string]int{"version": edited.CoverVersion}, h), 200).Order; ap.CoverApprovedAt == nil {
		t.Fatal("approval not recorded")
	}

	// Files are always handed out as downloads, recorded for the customer.
	must[struct {
		URL string `json:"url"`
	}](t, e.do("GET", "/api/v1/cd/shop/orders/"+o.ID+"/files/"+o.Files[0].ID+"/url", nil, staff), 200)
	if v := must[orderViewT](t, e.do("GET", path, nil, h), 200); v.Order.Files[0].Downloads != 1 || v.Order.Files[0].DownloadedBy != "Kavita" {
		t.Fatalf("download not recorded: %+v", v.Order.Files[0])
	}
	// The shop is working on it now, so the student can't pull the files away.
	if r := e.do("POST", path+"/delete-files", map[string]any{}, h); r.Status != 409 {
		t.Fatalf("student delete while shop works: %d", r.Status)
	}

	// Printing done (sent to the binder): files go 24 hours later, kept that long for a reprint.
	bound := must[shopOrderT](t, act("stage", map[string]any{"stage": "binding"}), 200).Order
	if f := bound.Files[0]; f.DeleteAfter == nil || !f.DeleteAfter.Equal(bound.UpdatedAt.Add(store.OrderReprintHours*time.Hour)) {
		t.Fatalf("after printing, file kept until %v (binding at %v)", f.DeleteAfter, bound.UpdatedAt)
	}
	e.clock.Advance(25 * time.Hour) // ready the next day
	e.deleter.RunOnce(context.Background())
	mid := must[orderViewT](t, e.do("GET", path, nil, h), 200).Order
	if mid.FilesDeletedAt == nil || mid.State != domain.OrderBinding || mid.Customer == "" || mid.Cover.Student == "" {
		t.Fatalf("files should be gone while the order goes on: %+v", mid)
	}
	staff = e.login("Kavita", "1111") // the 12-hour session expired overnight
	must[shopOrderT](t, act("stage", map[string]any{"stage": "ready"}), 200)
	if r := act("deliver", nil); r.Status != 422 || r.Error.Code != "balance_due" {
		t.Fatalf("deliver without balance: %d %+v", r.Status, r.Error)
	}
	done := must[shopOrderT](t, act("deliver", map[string]any{"method": "upi"}), 200).Order
	if done.State != domain.OrderDelivered || done.PaidPaise != 135000 || len(done.Payments) != 2 || done.Payments[1].Method != "upi" {
		t.Fatalf("delivered: %+v", done)
	}
	if r := act("stage", map[string]any{"stage": "ready"}); r.Status != 409 {
		t.Fatalf("stage after delivery: %d", r.Status)
	}

	// Dashboard: the advance counts yesterday, the balance today.
	owner := e.login("Owner", "1234")
	today := must[store.Dashboard](t, e.do("GET", "/api/v1/cd/shop/dashboard?days=1", nil, owner), 200)
	if today.Earnings.TotalPaise != 65000 || today.Earnings.UPIPaise != 65000 || today.Orders.BalancePaise != 65000 || today.Earnings.OrdersPaise != 65000 {
		t.Fatalf("today: %+v %+v", today.Earnings, today.Orders)
	}
	week := must[store.Dashboard](t, e.do("GET", "/api/v1/cd/shop/dashboard?days=7", nil, owner), 200)
	if week.Earnings.TotalPaise != 135000 || week.Earnings.CashPaise != 70000 || week.Orders.AdvancePaise != 70000 {
		t.Fatalf("week: %+v %+v", week.Earnings, week.Orders)
	}
	if len(week.Staff) != 1 || week.Staff[0].Name != "Kavita" || week.Staff[0].CashPaise != 70000 || week.Staff[0].UPIPaise != 65000 {
		t.Fatalf("staff: %+v", week.Staff)
	}

	// Delivered and the files already gone: the personal details go too; the amounts stay.
	after := must[orderViewT](t, e.do("GET", path, nil, h), 200).Order
	if after.FilesDeletedAt == nil || after.Customer != "" || after.Phone != "" || after.Cover.Student != "" || after.TotalPaise != 135000 {
		t.Fatalf("after deletion: %+v", after)
	}
	snap = must[store.OrdersSnapshot](t, e.do("GET", "/api/v1/cd/shop/orders", nil, staff), 200)
	if len(snap.Open) != 0 || len(snap.Recent) != 1 || snap.Recent[0].State != domain.OrderDelivered {
		t.Fatalf("history: open %d recent %+v", len(snap.Open), snap.Recent)
	}
}

// Staff can take an order at the counter (no files), quote it at once and share a link with the
// student. Cancelling refunds the advance or keeps it, as the shop chooses.
func TestCounterOrderAndCancel(t *testing.T) {
	e := setup(t)
	staff := e.login("Kavita", "1111")
	body := map[string]any{
		"service": "binding", "customerName": "Aman", "dueDate": "2026-10-01",
		"spec":  map[string]any{"copies": 2, "binding": "spiral", "pages": 40},
		"cover": blackbookCover,
		"lines": []map[string]any{{"label": "Spiral blackbook × 2", "paise": 30000}}, "advancePaise": 10000,
	}
	c := must[shopOrderT](t, e.do("POST", "/api/v1/cd/shop/orders", body, staff), 201)
	if c.Order.State != domain.OrderQuoted || c.Order.Channel != "counter" || c.Secret == "" {
		t.Fatalf("counter order: %+v", c.Order)
	}
	h := map[string]string{"X-Ticket-Secret": c.Secret}
	path := "/api/v1/cd/orders/" + c.Order.ID
	must[orderViewT](t, e.do("GET", path, nil, h), 200)

	// A new link replaces the old one.
	nl := must[shopOrderT](t, e.do("POST", "/api/v1/cd/shop/orders/"+c.Order.ID+"/link", nil, staff), 200)
	if r := e.do("GET", path, nil, h); r.Status == 200 {
		t.Fatal("old link still works")
	}
	h = map[string]string{"X-Ticket-Secret": nl.Secret}

	// The student can add their file later from the link.
	add := must[struct {
		View    orderViewT `json:"view"`
		Uploads []upload   `json:"uploads"`
	}](t, e.do("POST", path+"/files", map[string]any{"files": []map[string]any{{"clientId": "x", "filename": "report.pdf", "size": 50, "mime": "application/pdf"}}}, h), 200)
	if len(add.Uploads) != 1 || len(add.View.Order.Files) != 1 {
		t.Fatalf("add files: %+v", add)
	}
	// Before the shop starts work, the student may delete their files.
	gone := must[orderViewT](t, e.do("POST", path+"/delete-files", map[string]any{}, h), 200).Order
	if f := gone.Files[0]; f.DeleteAfter == nil || f.DeleteAfter.After(e.clock.Now()) {
		t.Fatalf("student delete before work: %+v", f)
	}

	must[shopOrderT](t, e.do("POST", "/api/v1/cd/shop/orders/"+c.Order.ID+"/pay", map[string]any{"kind": "advance", "method": "upi", "paise": 10000}, staff), 200)
	if r := e.do("POST", path+"/cancel", nil, h); r.Status != 409 {
		t.Fatalf("customer cancel after paying: %d", r.Status)
	}
	if r := e.do("POST", "/api/v1/cd/shop/orders/"+c.Order.ID+"/cancel", map[string]any{"method": "cash"}, staff); r.Status != 422 {
		t.Fatalf("cancel without reason: %d", r.Status)
	}
	x := must[shopOrderT](t, e.do("POST", "/api/v1/cd/shop/orders/"+c.Order.ID+"/cancel", map[string]any{"reason": "Student went elsewhere", "method": "cash"}, staff), 200).Order
	last := x.Payments[len(x.Payments)-1]
	if x.State != domain.OrderCancelled || x.PaidPaise != 0 || last.Kind != domain.PayRefund || last.Paise != -10000 {
		t.Fatalf("cancelled: %+v", x)
	}
	owner := e.login("Owner", "1234")
	d := must[store.Dashboard](t, e.do("GET", "/api/v1/cd/shop/dashboard?days=1", nil, owner), 200)
	if d.Earnings.TotalPaise != 0 || d.Earnings.UPIPaise != 10000 || d.Earnings.CashPaise != -10000 || d.Orders.RefundPaise != 10000 {
		t.Fatalf("dashboard after refund: %+v %+v", d.Earnings, d.Orders)
	}

	// Owner-only settings; staff can't change them.
	if r := e.do("PUT", "/api/v1/cd/shop/order-settings", map[string]any{"enabled": false}, staff); r.Status != 403 {
		t.Fatalf("staff settings: %d", r.Status)
	}
	must[domain.OrderSettings](t, e.do("PUT", "/api/v1/cd/shop/order-settings", map[string]any{"enabled": false, "hardPaise": 30000, "advancePercent": 40}, owner), 200)
	if r := e.do("POST", "/api/v1/cd/shops/demo-print/orders", map[string]any{"service": "blackbook", "customerName": "Z", "dueDate": "2026-10-09", "consent": true,
		"spec": map[string]any{"copies": 1, "binding": "hard"}, "cover": blackbookCover,
		"files": []map[string]any{{"clientId": "a", "filename": "a.pdf", "size": 10, "mime": "application/pdf"}}}, nil); r.Status != 422 {
		t.Fatalf("online order while disabled: %d", r.Status)
	}
}

// Other services use the same flow: visiting cards are counted and priced per 100 from the shop's
// price, need no file, and printing waits until the customer approves the words to print. Services
// the shop hasn't switched on can't be ordered online.
func TestVisitingCardOrder(t *testing.T) {
	e := setup(t)
	owner := e.login("Owner", "1234")
	// The shop prices cards at ₹350 per 100 and needs 1 day; flex stays off (default).
	set := must[domain.OrderSettings](t, e.do("PUT", "/api/v1/cd/shop/order-settings", map[string]any{"enabled": true, "hardPaise": 25000, "advancePercent": 50,
		"services": []map[string]any{{"id": "visiting", "enabled": true, "unitPaise": 35000, "leadDays": 1}}}, owner), 200)
	if len(set.Services) != len(domain.Catalogue) || set.Service("visiting").UnitPaise != 35000 || set.Service("flex").Enabled {
		t.Fatalf("settings: %+v", set.Services)
	}
	shop := must[struct {
		Orders struct {
			Services []domain.ServiceSetting `json:"services"`
			FileDays int                     `json:"fileDays"`
		} `json:"orders"`
	}](t, e.do("GET", "/api/v1/cd/shops/demo-print", nil, nil), 200)
	for _, s := range shop.Orders.Services {
		if s.ID == "flex" {
			t.Fatal("disabled service listed publicly")
		}
	}
	if shop.Orders.FileDays != store.OrderFileDays {
		t.Fatalf("file days %d", shop.Orders.FileDays)
	}
	if r := e.do("POST", "/api/v1/cd/shops/demo-print/orders", map[string]any{"service": "flex", "customerName": "Z", "dueDate": "2026-10-03", "consent": true,
		"spec": map[string]any{"quantity": 12}, "cover": map[string]any{"text": "SALE"}}, nil); r.Status != 422 {
		t.Fatalf("disabled service ordered: %d", r.Status)
	}
	card := map[string]any{"service": "visiting", "customerName": "Ravi", "dueDate": "2026-10-02", "consent": true,
		"spec": map[string]any{"quantity": 250, "size": "Standard"}, "cover": map[string]any{}}
	if r := e.do("POST", "/api/v1/cd/shops/demo-print/orders", card, nil); r.Status != 422 {
		t.Fatalf("cards without print text: %d", r.Status)
	}
	card["cover"] = map[string]any{"text": "Ravi Patil\nPatil Electricals\n98200 12345"}
	created := must[struct {
		View    orderViewT `json:"view"`
		Secret  string     `json:"secret"`
		Uploads []upload   `json:"uploads"`
	}](t, e.do("POST", "/api/v1/cd/shops/demo-print/orders", card, nil), 201)
	if created.Uploads == nil {
		t.Fatal("uploads should be an empty list, not null")
	}
	h := map[string]string{"X-Ticket-Secret": created.Secret}
	path := "/api/v1/cd/orders/" + created.View.Order.ID
	o := must[orderViewT](t, e.do("POST", path+"/submit", nil, h), 200).Order // no file needed for cards
	if o.State != domain.OrderRequested || o.Kind != "visiting" || o.Code[:3] != "OR-" {
		t.Fatalf("sent: %+v", o)
	}
	staff := e.login("Kavita", "1111")
	act := func(a string, body any) resp { return e.do("POST", "/api/v1/cd/shop/orders/"+o.ID+"/"+a, body, staff) }
	v := must[shopOrderT](t, e.do("GET", "/api/v1/cd/shop/orders/"+o.ID, nil, staff), 200)
	// 250 cards = 3 × ₹350.
	if len(v.Suggested) != 1 || v.Suggested[0].Paise != 105000 {
		t.Fatalf("suggested: %+v", v.Suggested)
	}
	must[shopOrderT](t, act("quote", map[string]any{"lines": v.Suggested, "advancePaise": 50000}), 200)
	must[shopOrderT](t, act("pay", map[string]any{"kind": "advance", "method": "cash", "paise": 50000}), 200)
	if r := act("stage", map[string]any{"stage": "printing"}); r.Status != 422 || r.Error.Code != "cover_required" {
		t.Fatalf("printing before approval: %d %+v", r.Status, r.Error)
	}
	ok := must[orderViewT](t, e.do("POST", path+"/approve-cover", map[string]int{"version": o.CoverVersion}, h), 200).Order
	if ok.CoverApprovedAt == nil {
		t.Fatal("approval not recorded")
	}
	must[shopOrderT](t, act("stage", map[string]any{"stage": "printing"}), 200)
	if r := e.do("PUT", path+"/cover", map[string]any{"text": "Changed"}, h); r.Status != 409 {
		t.Fatalf("print text changed after printing started: %d", r.Status)
	}
	must[shopOrderT](t, act("stage", map[string]any{"stage": "ready"}), 200)
	done := must[shopOrderT](t, act("deliver", map[string]any{"method": "upi"}), 200).Order
	if done.State != domain.OrderDelivered || done.PaidPaise != 105000 {
		t.Fatalf("delivered: %+v", done)
	}
}
