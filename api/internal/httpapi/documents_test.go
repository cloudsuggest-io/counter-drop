package httpapi_test

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"
)

const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// Word and other office files can be sent. The phone can't count their pages, so the price is
// confirmed at the counter: staff enter the page count when marking the job ready and the job
// is repriced from the price list. The browser can't open them, so they are always handed out
// as downloads (and the customer is told).
func TestDocumentsPagesConfirmedByShop(t *testing.T) {
	e := setup(t)

	// Programs and web pages are refused.
	for _, m := range []string{"application/x-msdownload", "text/html", "image/svg+xml", "application/zip", "application/vnd.ms-word.document.macroEnabled.12"} {
		r := e.do("POST", "/api/v1/cd/shops/demo-print/jobs", map[string]any{"files": []map[string]any{{"clientId": "0", "filename": "x", "size": 10, "mime": m}}}, nil)
		if r.Status != 422 {
			t.Fatalf("%s accepted: %d", m, r.Status)
		}
	}

	files := []map[string]any{
		{"clientId": "0", "filename": "Resume.docx", "size": 120, "mime": docxMime},
		{"clientId": "1", "filename": "photo.jpg", "size": 130, "mime": "image/jpeg"},
	}
	created := must[struct {
		Ticket  ticketT  `json:"ticket"`
		Secret  string   `json:"secret"`
		Uploads []upload `json:"uploads"`
	}](t, e.do("POST", "/api/v1/cd/shops/demo-print/jobs", map[string]any{"customerName": "Asha", "files": files}, nil), 201)
	h := map[string]string{"X-Ticket-Secret": created.Secret}
	jobPath := "/api/v1/cd/jobs/" + created.Ticket.Job.ID
	for i, u := range created.Uploads {
		req, _ := http.NewRequest("PUT", u.URL, bytes.NewReader(bytes.Repeat([]byte("x"), 120+10*i)))
		for k, v := range u.Headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("PUT upload: %v", err)
		}
		res.Body.Close()
		must[ticketT](t, e.do("POST", jobPath+"/files/"+u.FileID+"/complete", map[string]int{"pages": 0}, h), 200)
	}
	doc := created.Uploads[0].FileID
	// Two copies of the Word file.
	tk := must[ticketT](t, e.do("PATCH", jobPath, map[string]any{"files": []map[string]any{{"fileId": doc, "settings": map[string]any{"copies": 2}}}}, h), 200)
	if f := tk.Job.Files[0]; f.PagesStatus != domain.PagesUnknown || f.Pages != 0 {
		t.Fatalf("doc pages: %+v", f)
	}
	// The photo is priced now (₹2); the Word file waits for the counter.
	if !tk.Quote.PagesToConfirm || tk.Quote.TotalPaise != 200 {
		t.Fatalf("quote: %+v", tk.Quote)
	}
	sub := must[ticketT](t, e.do("POST", jobPath+"/submit", map[string]string{"priceVersion": tk.Quote.PriceVersion}, h), 200)
	if !sub.Job.PagesToConfirm {
		t.Fatalf("submitted job should have pages to confirm")
	}

	staff := e.login("Kavita", "1111")
	e.clock.Advance(2 * time.Minute)
	must[domain.Job](t, e.do("POST", "/api/v1/cd/shop/claim-next", map[string]string{"lane": "A"}, staff), 200)

	// Asking to "print" a Word file hands it out as a download, and that is recorded.
	e.fileLink(staff, sub.Job.ID, doc, "print")
	cust := e.ticket(sub.Job.ID, created.Secret)
	if f := cust.Job.Files[0]; f.Downloads != 1 || f.PrintOpens != 0 || f.DownloadedBy != "Kavita" {
		t.Fatalf("doc access: downloads %d opens %d by %q", f.Downloads, f.PrintOpens, f.DownloadedBy)
	}
	// A photo the browser can show still opens to print.
	e.fileLink(staff, sub.Job.ID, created.Uploads[1].FileID, "print")
	if f := e.ticket(sub.Job.ID, created.Secret).Job.Files[1]; f.PrintOpens != 1 || f.Downloads != 0 {
		t.Fatalf("photo access: %+v", f)
	}

	e.clock.Advance(3 * time.Minute)
	ready := "/api/v1/cd/shop/jobs/" + sub.Job.ID + "/ready"
	if r := e.do("POST", ready, nil, staff); r.Status != 422 || r.Error.Code != "pages_required" {
		t.Fatalf("ready without pages: %d %+v", r.Status, r.Error)
	}
	if r := e.do("POST", ready, map[string]any{"pages": map[string]int{doc: 0}}, staff); r.Status != 422 {
		t.Fatalf("zero pages: %d", r.Status)
	}
	if r := e.do("POST", ready, map[string]any{"pages": map[string]int{"file_nope": 3}}, staff); r.Status != 404 {
		t.Fatalf("unknown file: %d", r.Status)
	}
	// 5 pages × 2 copies at ₹2 a side = ₹20, plus ₹2 for the photo.
	j := must[domain.Job](t, e.do("POST", ready, map[string]any{"pages": map[string]int{doc: 5}}, staff), 200)
	if j.State != domain.JobStateReady || j.PagesToConfirm || j.PriceTotal != 2200 || j.PagesTotal != 11 {
		t.Fatalf("ready: %s toConfirm %v total %d pages %d", j.State, j.PagesToConfirm, j.PriceTotal, j.PagesTotal)
	}
	if f := j.Files[0]; f.Pages != 5 || f.PagesStatus != domain.PagesConfirmed {
		t.Fatalf("confirmed file: %+v", f)
	}
	if c := e.ticket(sub.Job.ID, created.Secret); c.Job.PriceTotal != 2200 || c.Job.PagesToConfirm {
		t.Fatalf("customer sees %d (to confirm %v)", c.Job.PriceTotal, c.Job.PagesToConfirm)
	}

	e.clock.Advance(4 * time.Minute)
	must[domain.Job](t, e.do("POST", "/api/v1/cd/shop/jobs/"+sub.Job.ID+"/collected", map[string]any{"paid": "cash"}, staff), 200)

	// The owner's dashboard counts it; staff can't open the dashboard.
	if r := e.do("GET", "/api/v1/cd/shop/dashboard", nil, staff); r.Status != 403 {
		t.Fatalf("staff dashboard: %d", r.Status)
	}
	owner := e.login("Owner", "1234")
	d := must[store.Dashboard](t, e.do("GET", "/api/v1/cd/shop/dashboard?days=1", nil, owner), 200)
	if d.Days != 1 || d.Earnings.TotalPaise != 2200 || d.Earnings.CashPaise != 2200 || d.Jobs.Submitted != 1 || d.Jobs.Collected != 1 || d.Jobs.Files != 2 {
		t.Fatalf("dashboard money/jobs: %+v %+v", d.Earnings, d.Jobs)
	}
	if d.Pages.Printed != 11 || d.Pages.DocFiles != 1 || d.Pages.PhotoFiles != 1 || d.Pages.BW != 11 {
		t.Fatalf("dashboard pages: %+v", d.Pages)
	}
	if d.Speed.WaitSec != 120 || d.Speed.PrintSec != 180 || d.Speed.PickupSec != 240 || d.Speed.WithinTenPct != 100 {
		t.Fatalf("dashboard speed: %+v", d.Speed)
	}
	if len(d.Staff) != 1 || d.Staff[0].Name != "Kavita" || d.Staff[0].Jobs != 1 || d.Staff[0].CashPaise != 2200 || d.Staff[0].Pages != 11 {
		t.Fatalf("dashboard staff: %+v", d.Staff)
	}
	if len(d.Series) != 7 || d.Series[6].Paise != 2200 || d.Previous.Label != "last Thursday" {
		t.Fatalf("dashboard series: %+v %+v", d.Series, d.Previous)
	}
	for _, days := range []int{7, 30} {
		d := must[store.Dashboard](t, e.do("GET", "/api/v1/cd/shop/dashboard?days="+map[int]string{7: "7", 30: "30"}[days], nil, owner), 200)
		if d.Days != days || len(d.Series) != days || d.Earnings.TotalPaise != 2200 {
			t.Fatalf("%d-day dashboard: days %d series %d total %d", days, d.Days, len(d.Series), d.Earnings.TotalPaise)
		}
	}
}
