package store

import (
	"testing"
	"time"

	"counter-drop/api/internal/domain"
)

func at(t time.Time) *time.Time { return &t }

func TestBuildDashboard(t *testing.T) {
	sh := domain.Shop{Timezone: "Asia/Kolkata"}
	loc := sh.Location()
	now := time.Date(2026, 10, 18, 18, 40, 0, 0, loc) // Sunday 6:40 pm
	day := func(daysAgo int, h, m int) time.Time {
		return time.Date(2026, 10, 18-daysAgo, h, m, 0, 0, loc)
	}
	pdf := func(pages int, s domain.FileSettings) domain.JobFile {
		return domain.JobFile{Mime: "application/pdf", Pages: pages, Settings: s}
	}
	collected := func(id string, sent time.Time, paise int64, paid, by string, files ...domain.JobFile) domain.Job {
		claimed, ready, coll := sent.Add(2*time.Minute), sent.Add(5*time.Minute), sent.Add(20*time.Minute)
		return domain.Job{ID: id, State: domain.JobStateCollected, BusinessDay: domain.BusinessDay(sent, loc), PriceTotal: paise,
			PaidMethod: paid, ClaimedBy: by, CollectedBy: by, QueuedAt: at(sent), ClaimedAt: &claimed, ReadyAt: &ready, CollectedAt: &coll, Files: files}
	}
	other := int64(5000)
	laminate := collected("j3", day(0, 11, 0), 5000, "", "Sana", domain.JobFile{Mime: "image/jpeg", Pages: 1, Settings: domain.FileSettings{Other: true, Copies: 1}})
	laminate.OtherPrice = &other
	jobs := []domain.Job{
		collected("j1", day(0, 10, 5), 1200, "cash", "Imran", pdf(10, domain.FileSettings{Copies: 2, BothSides: true, PageRange: "1-3"})),
		collected("j2", day(0, 17, 30), 3000, "upi", "Sana", pdf(3, domain.FileSettings{Copies: 1, Colour: true}), domain.JobFile{Mime: docxMime, Pages: 4, PagesStatus: domain.PagesConfirmed, Settings: domain.FileSettings{Copies: 1}}),
		laminate,
		// Last Sunday: one before this time of day counts, one after doesn't.
		collected("p1", day(7, 9, 0), 1000, "cash", "Imran", pdf(1, domain.FileSettings{Copies: 1})),
		collected("p2", day(7, 19, 0), 9000, "cash", "Imran", pdf(1, domain.FileSettings{Copies: 1})),
		{ID: "c1", State: domain.JobStateCancelled, BusinessDay: "2026-10-18", QueuedAt: at(day(0, 12, 0)), CancelledAt: at(day(0, 12, 5)), CancelReason: "customer_cancelled"},
		{ID: "c2", State: domain.JobStateCancelled, BusinessDay: "2026-10-18", QueuedAt: at(day(0, 12, 0)), CancelledAt: at(day(0, 13, 0)), CancelReason: "printer jam"},
		// Sent yesterday, collected today: today's money, yesterday's job.
		collected("y1", day(1, 23, 50), 400, "", "Ravi", pdf(2, domain.FileSettings{Copies: 1})),
	}
	jobs = append(jobs, jobs[0]) // duplicates are ignored
	readyAt := day(0, 18, 0)
	open := []domain.Job{
		{ID: "o1", State: domain.JobStateQueued},
		{ID: "o2", State: domain.JobStateReady, Token: "A-31", ReadyAt: &readyAt},
		{ID: "o3", State: domain.JobStateReady, Token: "A-40", ReadyAt: at(day(0, 18, 30)), PagesToConfirm: true},
	}
	d := BuildDashboard(DashboardInput{Shop: sh, Now: now, Days: 1, Jobs: jobs, Open: open, CopiesToConfirm: 2})

	if d.From != "2026-10-18" || d.To != "2026-10-18" {
		t.Fatalf("period %s..%s", d.From, d.To)
	}
	e := d.Earnings
	if e.TotalPaise != 9600 || e.CashPaise != 1200 || e.UPIPaise != 3000 || e.UnrecordedPaise != 5400 || e.UnrecordedJobs != 2 {
		t.Fatalf("earnings %+v", e)
	}
	if d.Previous.Paise != 1000 || d.Previous.Jobs != 1 || d.Previous.Label != "last Sunday" {
		t.Fatalf("previous %+v", d.Previous)
	}
	if d.Jobs.Submitted != 5 || d.Jobs.Collected != 4 || d.Jobs.Cancelled != 2 || d.Jobs.MaxBillPaise != 5000 || d.Jobs.AvgBillPaise != 2400 {
		t.Fatalf("jobs %+v", d.Jobs)
	}
	// j1: pages 1-3 × 2 copies both sides = 6 printed, 4 sheets; j2: 3 colour + 4 B/W; y1 was printed yesterday.
	p := d.Pages
	if p.Printed != 13 || p.Sheets != 11 || p.Colour != 3 || p.BW != 10 || p.BothSides != 6 || p.OneSide != 7 {
		t.Fatalf("pages %+v", p)
	}
	if p.PDFFiles != 2 || p.DocFiles != 1 || p.OtherFiles != 1 || p.OtherPaise != 5000 {
		t.Fatalf("files %+v", p)
	}
	if d.Speed.WaitSec != 120 || d.Speed.PrintSec != 180 || d.Speed.WithinTenPct != 100 || d.Speed.Samples != 3 {
		t.Fatalf("speed %+v", d.Speed)
	}
	if d.Hours[17].Jobs != 1 || d.Hours[12].Jobs != 2 || d.Hours[9].Prev != 1 || d.Hours[19].Prev != 0 {
		t.Fatalf("hours %+v", d.Hours)
	}
	if len(d.Series) != 7 || d.Series[6].Day != "2026-10-18" || d.Series[6].Paise != 9600 || d.Series[6].PrevPaise != 10000 {
		t.Fatalf("series %+v", d.Series[6])
	}
	if len(d.Staff) != 3 || d.Staff[0].Name != "Sana" || d.Staff[0].Jobs != 2 || d.Staff[0].UPIPaise != 3000 {
		t.Fatalf("staff %+v", d.Staff)
	}
	if d.Now.InLine != 1 || d.Now.Ready != 2 || d.Now.OldestReadyToken != "A-31" || d.Now.OldestReadyMin != 40 || d.Now.CopiesToConfirm != 2 || d.Now.PagesToConfirm != 1 {
		t.Fatalf("now %+v", d.Now)
	}
	if d.Problems.CancelledByCustomer != 1 || d.Problems.CancelledByShop != 1 {
		t.Fatalf("problems %+v", d.Problems)
	}

	// 7 days: the window is a week, compared with the week before.
	w := BuildDashboard(DashboardInput{Shop: sh, Now: now, Days: 7, Jobs: jobs})
	if w.From != "2026-10-12" || w.Earnings.TotalPaise != 9600 || w.Previous.Paise != 10000 || w.Previous.Label != "previous 7 days" {
		t.Fatalf("7 days: %s %+v %+v", w.From, w.Earnings, w.Previous)
	}
	if n := len(DashboardDays(sh, now, 30)); n != 61 {
		t.Fatalf("30-day fetch covers %d days", n)
	}
}

const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

func TestDashboardOrders(t *testing.T) {
	sh := domain.Shop{Timezone: "Asia/Kolkata"}
	loc := sh.Location()
	now := time.Date(2026, 10, 18, 18, 0, 0, 0, loc)
	pay := func(daysAgo int, kind, method string, paise int64) OrderPaymentRow {
		return OrderPaymentRow{Kind: kind, Method: method, Paise: paise, At: time.Date(2026, 10, 18-daysAgo, 12, 0, 0, 0, loc), By: "Imran"}
	}
	open := []domain.Order{
		{State: domain.OrderRequested, DueDate: "2026-10-18"},
		{State: domain.OrderConfirmed, DueDate: "2026-10-18", TotalPaise: 100000, PaidPaise: 50000},
		{State: domain.OrderBinding, DueDate: "2026-10-16", TotalPaise: 60000, PaidPaise: 30000},
		{State: domain.OrderReady, DueDate: "2026-10-15", TotalPaise: 40000, PaidPaise: 40000},
		{State: domain.OrderDraft, DueDate: "2026-10-18"},
	}
	d := BuildDashboard(DashboardInput{Shop: sh, Now: now, Days: 1, OpenOrders: open, Payments: []OrderPaymentRow{
		pay(0, domain.PayAdvance, "cash", 50000), pay(0, domain.PayBalance, "upi", 20000), pay(0, domain.PayRefund, "cash", -5000), pay(3, domain.PayAdvance, "cash", 9999),
	}})
	if d.Earnings.TotalPaise != 65000 || d.Earnings.CashPaise != 45000 || d.Earnings.UPIPaise != 20000 || d.Earnings.OrdersPaise != 65000 {
		t.Fatalf("earnings %+v", d.Earnings)
	}
	o := d.Orders
	if o.AdvancePaise != 50000 || o.BalancePaise != 20000 || o.RefundPaise != 5000 {
		t.Fatalf("money %+v", o)
	}
	// Ready orders aren't overdue (only waiting for pickup); drafts aren't counted.
	if o.Open != 4 || o.NeedQuote != 1 || o.DueToday != 2 || o.Overdue != 1 || o.Ready != 1 || o.PendingPaise != 80000 {
		t.Fatalf("book %+v", o)
	}
	if d.Series[3].Paise != 9999 || d.Staff[0].CashPaise != 45000 {
		t.Fatalf("series/staff %+v %+v", d.Series[3], d.Staff)
	}
}
