package domain

import (
	"errors"
	"testing"
	"time"
)

func TestOrderLifecycle(t *testing.T) {
	now := time.Date(2026, 10, 18, 11, 0, 0, 0, IST)
	o := Order{Kind: "blackbook", State: OrderRequested, Spec: OrderSpec{Copies: 3, Binding: BindingHard, Pages: 80, ColourPages: "1-4"}}
	if err := o.AddPayment(OrderPayment{Kind: PayAdvance, Method: "cash", Paise: 100}, now); err == nil {
		t.Fatal("payment before quote accepted")
	}
	lines := SuggestQuote(DefaultPriceList(), DefaultOrderSettings(), o.Service(), o.Spec)
	// 76 B/W × 3 at ₹2, 4 colour × 3 at ₹10, hard binding ₹250 × 3
	if len(lines) != 3 || lines[0].Paise != 45600 || lines[1].Paise != 12000 || lines[2].Paise != 75000 {
		t.Fatalf("suggested: %+v", lines)
	}
	if err := o.SetQuote(lines, 66300, now, "Imran"); err != nil || o.State != OrderQuoted || o.TotalPaise != 132600 {
		t.Fatalf("quote: %v %+v", err, o)
	}
	if err := o.AddPayment(OrderPayment{Kind: PayAdvance, Method: "card", Paise: 100}, now); err == nil {
		t.Fatal("bad method accepted")
	}
	if err := o.AddPayment(OrderPayment{Kind: PayAdvance, Method: "upi", Paise: 200000}, now); err == nil {
		t.Fatal("overpayment accepted")
	}
	if err := o.AddPayment(OrderPayment{Kind: PayAdvance, Method: "upi", Paise: 66300, By: "Imran"}, now); err != nil || o.State != OrderConfirmed || o.BalancePaise() != 66300 {
		t.Fatalf("advance: %v %s %d", err, o.State, o.BalancePaise())
	}
	if err := o.SetQuote([]OrderLine{{Label: "Discounted", Paise: 50000}}, 0, now, "Imran"); err == nil {
		t.Fatal("total below paid accepted")
	}
	// Skipping ahead past binding can't dodge the student's cover approval.
	if err := o.SetStage(OrderReady, now, "Imran"); !errors.Is(err, ErrCoverRequired) {
		t.Fatalf("ready without approved cover: %v", err)
	}
	if err := o.SetCover(CoverText{Title: "UPI", Student: "Riya Shah", College: "RA Podar"}, now, "Imran"); err != nil {
		t.Fatal(err)
	}
	_ = o.ApproveCover(o.CoverVersion, now)
	if err := o.SetStage(OrderReady, now, "Imran"); err != nil {
		// skipping ahead is allowed once approved
		t.Fatal(err)
	}
	if err := o.SetCover(CoverText{Title: " A study of   UPI ", Student: "Riya Shah", College: "RA Podar"}, now, "Imran"); !errors.Is(err, ErrOrderState) {
		t.Fatalf("cover edit when ready: %v", err)
	}
	if err := o.SetStage(OrderPrinting, now, "Imran"); err == nil {
		t.Fatal("two steps back accepted")
	}
	if err := o.Deliver("", now, "Sana", "p2"); !errors.Is(err, ErrBalanceDue) {
		t.Fatalf("deliver with balance: %v", err)
	}
	if err := o.Deliver("cash", now, "Sana", "p2"); err != nil || o.State != OrderDelivered || o.BalancePaise() != 0 || len(o.Payments) != 2 || o.Payments[1].Kind != PayBalance {
		t.Fatalf("deliver: %v %+v", err, o.Payments)
	}
}

func TestOrderCoverApprovalAndCancel(t *testing.T) {
	now := time.Date(2026, 10, 18, 11, 0, 0, 0, IST)
	o := Order{Kind: "blackbook", State: OrderConfirmed, Spec: OrderSpec{Copies: 1, Binding: BindingHard}, TotalPaise: 50000}
	if err := o.SetCover(CoverText{Title: "x"}, now, "s"); err == nil {
		t.Fatal("cover without student accepted")
	}
	if err := o.SetCover(CoverText{Title: " A study of   UPI ", Student: "Riya Shah", College: "RA Podar"}, now, "s"); err != nil || o.Cover.Title != "A study of UPI" || o.CoverVersion != 1 {
		t.Fatalf("cover: %v %+v", err, o.Cover)
	}
	if err := o.ApproveCover(0, now); err == nil {
		t.Fatal("stale approval accepted")
	}
	if err := o.ApproveCover(1, now); err != nil || o.CoverApprovedAt == nil {
		t.Fatal(err)
	}
	// Any change clears the approval.
	_ = o.SetCover(CoverText{Title: "A study of UPI", Student: "Riya Shaw", College: "RA Podar"}, now, "s")
	if o.CoverApprovedAt != nil || o.CoverVersion != 2 {
		t.Fatal("approval kept after change")
	}
	_ = o.ApproveCover(2, now)
	if err := o.SetStage(OrderBinding, now, "s"); err != nil {
		t.Fatal(err)
	}
	o.State = OrderConfirmed
	_ = o.AddPayment(OrderPayment{Kind: PayAdvance, Method: "cash", Paise: 20000}, now)
	if err := o.Cancel("", "", now, "s", "p"); !errors.Is(err, ErrReasonRequired) {
		t.Fatal("cancel without reason")
	}
	if err := o.Cancel("Student changed shop", "cash", now, "s", "p"); err != nil || o.PaidPaise != 0 || o.Payments[len(o.Payments)-1].Paise != -20000 {
		t.Fatalf("refund cancel: %v %+v", err, o.Payments)
	}
}

func TestValidDueDateAndRupees(t *testing.T) {
	now := time.Date(2026, 10, 18, 23, 30, 0, 0, IST)
	if err := ValidDueDate("2026-10-20", now, IST, 3); err == nil {
		t.Fatal("too soon accepted")
	}
	if err := ValidDueDate("2026-10-21", now, IST, 3); err != nil {
		t.Fatal(err)
	}
	if err := ValidDueDate("2026-10-18", now, IST, 0); err != nil {
		t.Fatal(err)
	}
	if got := rupeesText(12345678); got != "1,23,456.78" {
		t.Fatal(got)
	}
}

// Every service validates its own fields, prices from the shop's settings, and gates work on its proof.
func TestOrderServices(t *testing.T) {
	now := time.Date(2026, 10, 18, 11, 0, 0, 0, IST)
	os := DefaultOrderSettings()
	pl := DefaultPriceList()
	svc := func(id string) Service {
		s, ok := ServiceByID(id)
		if !ok {
			t.Fatalf("no service %s", id)
		}
		return s
	}

	// Visiting cards: quantity priced per 100 (250 cards = 3 boxes of 100 at ₹300).
	vc := svc("visiting")
	spec, err := OrderSpec{Quantity: 250, Size: "  3.5 × 2  in ", Copies: 9, Binding: "hard"}.Validate(vc)
	if err != nil || spec.Copies != 0 || spec.Binding != "" || spec.Size != "3.5 × 2 in" {
		t.Fatalf("visiting spec: %v %+v", err, spec)
	}
	if l := SuggestQuote(pl, os, vc, spec); len(l) != 1 || l[0].Paise != 90000 || l[0].Label != "Visiting cards · 250 cards (₹300 per 100 cards)" {
		t.Fatalf("visiting quote: %+v", l)
	}
	if _, err := (OrderSpec{}).Validate(vc); err == nil {
		t.Fatal("no quantity accepted")
	}
	// Flex is per square foot.
	if l := SuggestQuote(pl, os, svc("flex"), OrderSpec{Quantity: 18}); len(l) != 1 || l[0].Paise != 27000 {
		t.Fatalf("flex quote: %+v", l)
	}
	// Bulk printing: loose sheets by default, so no binding line.
	bulk, err := OrderSpec{Copies: 200, Pages: 10}.Validate(svc("bulk"))
	if err != nil || bulk.Binding != BindingNone {
		t.Fatalf("bulk spec: %v %+v", err, bulk)
	}
	if l := SuggestQuote(pl, os, svc("bulk"), bulk); len(l) != 1 || l[0].Paise != 400000 {
		t.Fatalf("bulk quote: %+v", l)
	}
	// Something else: described in words, priced by the shop.
	if _, err := (OrderSpec{Description: "hi"}).Validate(svc("other")); err == nil {
		t.Fatal("too short description accepted")
	}
	if l := SuggestQuote(pl, os, svc("other"), OrderSpec{Description: "Spiral 3 notebooks"}); l != nil {
		t.Fatalf("other quote: %+v", l)
	}

	// Text proof: cards need the words to print, and printing waits for approval.
	if _, err := (CoverText{Title: "x"}).Validate(ProofText); err == nil {
		t.Fatal("empty print text accepted")
	}
	c, err := CoverText{Text: "  Ravi   Patil \r\n  98200 12345  \n", Title: "dropped"}.Validate(ProofText)
	if err != nil || c.Text != "Ravi Patil\n98200 12345" || c.Title != "" {
		t.Fatalf("print text: %v %q", err, c.Text)
	}
	o := Order{Kind: "visiting", State: OrderConfirmed, Spec: spec, Cover: c, CoverVersion: 1}
	if err := o.SetStage(OrderPrinting, now, "s"); !errors.Is(err, ErrCoverRequired) {
		t.Fatalf("printing cards before approval: %v", err)
	}
	_ = o.ApproveCover(1, now)
	if err := o.SetStage(OrderPrinting, now, "s"); err != nil {
		t.Fatal(err)
	}
	if !o.ProofLocked() || o.SetCover(CoverText{Text: "New text"}, now, "s") == nil {
		t.Fatal("print text editable after printing started")
	}
	// No proof: lamination goes straight through; approval isn't a thing.
	lam := Order{Kind: "lamination", State: OrderConfirmed}
	if err := lam.SetStage(OrderReady, now, "s"); err != nil || lam.ApproveCover(0, now) == nil {
		t.Fatalf("lamination: %v", err)
	}

	// Settings: every catalogue service once, unknown IDs dropped, new services get defaults.
	n := OrderSettings{Enabled: true, Services: []ServiceSetting{{ID: "flex", Enabled: true, UnitPaise: 2000, LeadDays: 2}, {ID: "nope"}}}.Normalise()
	if len(n.Services) != len(Catalogue) || n.Service("flex").UnitPaise != 2000 || !n.Service("flex").Enabled || n.Service("nope").ID != "" || n.Service("photo").UnitPaise != 1000 {
		t.Fatalf("normalise: %+v", n.Services)
	}
	if (OrderSettings{Services: []ServiceSetting{{ID: "nope"}}}).Validate() == nil {
		t.Fatal("unknown service accepted")
	}
}
