package store

import (
	"sort"
	"time"

	"counter-drop/api/internal/domain"
)

// Dashboard is the owner's summary of the shop for a period: today, the last 7 days or the
// last 30 days (business days in the shop's time zone, ending today).
//
// Money is counted when a job is collected (that is when the shop is paid); pages and speed
// when a job is marked ready (that is when it was printed); jobs, hours and files by the day
// they were sent.
type Dashboard struct {
	Days       int       `json:"days"`
	From       string    `json:"from"` // first business day in the period (YYYY-MM-DD)
	To         string    `json:"to"`   // today
	ServerTime time.Time `json:"serverTime"`

	Earnings Earnings   `json:"earnings"`
	Previous Comparison `json:"previous"`
	Jobs     JobStats   `json:"jobs"`
	Pages    PageStats  `json:"pages"`
	Speed    SpeedStats `json:"speed"`
	// Hours are jobs sent in each hour of the day (0–23, shop time), with the comparison period.
	Hours []HourCount `json:"hours"`
	// Series has one point per day for the last max(days, 7) days, with the same day one
	// comparison period earlier (7 days back, or 30 for the 30-day view).
	Series   []DayPoint `json:"series"`
	Staff    []StaffRow `json:"staff"`
	Now      NowStats   `json:"now"`
	Problems Problems   `json:"problems"`
	// FilesDeleted is how many customer files were erased in the period.
	FilesDeleted int `json:"filesDeleted"`
}

type Earnings struct {
	TotalPaise      int64 `json:"totalPaise"`
	CashPaise       int64 `json:"cashPaise"`
	UPIPaise        int64 `json:"upiPaise"`
	UnrecordedPaise int64 `json:"unrecordedPaise"` // collected without marking cash or UPI
	UnrecordedJobs  int   `json:"unrecordedJobs"`
}

// Comparison is the same measure for the earlier period. For "today" it is the same weekday
// last week up to the same time of day, so a half-finished day is compared fairly.
type Comparison struct {
	Paise int64  `json:"paise"`
	Jobs  int    `json:"jobs"`
	Label string `json:"label"` // "last Sunday", "previous 7 days"
}

type JobStats struct {
	Submitted    int   `json:"submitted"`
	Collected    int   `json:"collected"`
	Cancelled    int   `json:"cancelled"`
	Files        int   `json:"files"`
	AvgBillPaise int64 `json:"avgBillPaise"`
	MaxBillPaise int64 `json:"maxBillPaise"`
}

type PageStats struct {
	Printed    int   `json:"printed"` // printed sides × copies
	Sheets     int   `json:"sheets"`  // sheets of paper used
	BW         int   `json:"bw"`
	Colour     int   `json:"colour"`
	OneSide    int   `json:"oneSide"`
	BothSides  int   `json:"bothSides"`
	PDFFiles   int   `json:"pdfFiles"`
	PhotoFiles int   `json:"photoFiles"`
	DocFiles   int   `json:"docFiles"` // Word, Excel, PowerPoint, text…
	OtherFiles int   `json:"otherFiles"`
	OtherPaise int64 `json:"otherPaise"`
}

// SpeedStats are averages in seconds.
type SpeedStats struct {
	WaitSec      int `json:"waitSec"`      // sent → printing started
	PrintSec     int `json:"printSec"`     // printing started → ready
	PickupSec    int `json:"pickupSec"`    // ready → collected
	WithinTenPct int `json:"withinTenPct"` // % of jobs ready within 10 minutes of being sent
	Samples      int `json:"samples"`
}

type HourCount struct {
	Hour int `json:"hour"`
	Jobs int `json:"jobs"`
	Prev int `json:"prev"`
}

type DayPoint struct {
	Day       string `json:"day"`
	Paise     int64  `json:"paise"`
	Jobs      int    `json:"jobs"`
	PrevPaise int64  `json:"prevPaise"`
	PrevJobs  int    `json:"prevJobs"`
}

type StaffRow struct {
	Name        string `json:"name"`
	Jobs        int    `json:"jobs"`  // jobs they printed (claimed and marked ready)
	Pages       int    `json:"pages"` // pages in those jobs
	AvgPrintSec int    `json:"avgPrintSec"`
	CashPaise   int64  `json:"cashPaise"` // cash they took (jobs they marked collected as cash)
	UPIPaise    int64  `json:"upiPaise"`
}

type NowStats struct {
	InLine           int    `json:"inLine"`
	Printing         int    `json:"printing"`
	Ready            int    `json:"ready"`
	OldestReadyToken string `json:"oldestReadyToken,omitempty"`
	OldestReadyMin   int    `json:"oldestReadyMin"`
	CopiesToConfirm  int    `json:"copiesToConfirm"`
	PagesToConfirm   int    `json:"pagesToConfirm"`
}

type Problems struct {
	CancelledByCustomer int `json:"cancelledByCustomer"`
	CancelledByShop     int `json:"cancelledByShop"`
	NotCollected        int `json:"notCollected"`
	NoReceipt           int `json:"noReceipt"`
	LongWaits           int `json:"longWaits"` // ready more than 15 minutes after being sent
}

// DashboardInput is everything BuildDashboard needs; Jobs must cover DashboardDays.
type DashboardInput struct {
	Shop            domain.Shop
	Now             time.Time
	Days            int
	Jobs            []domain.Job // jobs sent on the days DashboardDays returns
	Open            []domain.Job // jobs in line, printing or ready now
	CopiesToConfirm int
}

// dashboardShape returns the series length and how far back the comparison period starts.
func dashboardShape(days int) (series, offset int) {
	series, offset = max(days, 7), 7
	if days > 7 {
		offset = days
	}
	return
}

// NormaliseDashboardDays allows 1, 7 or 30.
func NormaliseDashboardDays(days int) int {
	switch days {
	case 7, 30:
		return days
	}
	return 1
}

// DashboardDays lists the business days whose jobs the dashboard reads, newest first: the
// series, its comparison period, and one extra day for jobs collected the day after sending.
func DashboardDays(sh domain.Shop, now time.Time, days int) []string {
	series, offset := dashboardShape(NormaliseDashboardDays(days))
	return businessDays(sh, now, series+offset+1)
}

func businessDays(sh domain.Shop, now time.Time, n int) []string {
	local := now.In(sh.Location())
	d0 := time.Date(local.Year(), local.Month(), local.Day(), 12, 0, 0, 0, local.Location())
	out := make([]string, n)
	for i := range out {
		out[i] = d0.AddDate(0, 0, -i).Format("2006-01-02")
	}
	return out
}

const (
	cancelCustomer     = "customer_cancelled"
	cancelNotCollected = "not_collected"
	longWait           = 15 * time.Minute
	quickReady         = 10 * time.Minute
)

// BuildDashboard aggregates the jobs into the owner's dashboard.
func BuildDashboard(in DashboardInput) Dashboard {
	days := NormaliseDashboardDays(in.Days)
	seriesLen, offset := dashboardShape(days)
	loc := in.Shop.Location()
	all := businessDays(in.Shop, in.Now, seriesLen+offset)
	period := toSet(all[:days])
	prevPeriod := toSet(all[offset : offset+days])
	dayOf := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return domain.BusinessDay(*t, loc)
	}
	// For "today" the comparison stops at the same time of day last week.
	prevCutoff := in.Now.AddDate(0, 0, -offset)
	inPrev := func(t *time.Time) bool {
		return t != nil && prevPeriod[dayOf(t)] && (days != 1 || !t.After(prevCutoff))
	}

	d := Dashboard{Days: days, From: all[days-1], To: all[0], ServerTime: in.Now, Hours: make([]HourCount, 24)}
	for h := range d.Hours {
		d.Hours[h].Hour = h
	}
	if days == 1 {
		d.Previous.Label = "last " + in.Now.In(loc).Weekday().String()
	} else if days == 7 {
		d.Previous.Label = "previous 7 days"
	} else {
		d.Previous.Label = "previous 30 days"
	}

	seriesIdx := map[string]int{}
	prevIdx := map[string]int{}
	d.Series = make([]DayPoint, seriesLen)
	for i := 0; i < seriesLen; i++ {
		day := all[seriesLen-1-i] // oldest first
		d.Series[i].Day = day
		seriesIdx[day] = i
		prevIdx[all[seriesLen-1-i+offset]] = i
	}

	staff := map[string]*StaffRow{}
	staffRow := func(name string) *StaffRow {
		if name == "" {
			name = "—"
		}
		r := staff[name]
		if r == nil {
			r = &StaffRow{Name: name}
			staff[name] = r
		}
		return r
	}
	printSecs := map[string]int64{}

	var waitSum, printSum, pickupSum int64
	var waitN, printN, pickupN, quick int

	seen := map[string]bool{}
	for _, j := range in.Jobs {
		if seen[j.ID] || j.QueuedAt == nil {
			continue
		}
		seen[j.ID] = true

		// Sent in the period: jobs, files, busy hours.
		sentDay := j.BusinessDay
		if sentDay == "" {
			sentDay = dayOf(j.QueuedAt)
		}
		if period[sentDay] {
			d.Jobs.Submitted++
			d.Jobs.Files += len(j.Files)
			d.Hours[j.QueuedAt.In(loc).Hour()].Jobs++
		}
		if inPrev(j.QueuedAt) {
			d.Hours[j.QueuedAt.In(loc).Hour()].Prev++
		}

		// Collected: money.
		if j.State == domain.JobStateCollected && j.CollectedAt != nil {
			cday := dayOf(j.CollectedAt)
			if period[cday] {
				d.Jobs.Collected++
				d.Earnings.TotalPaise += j.PriceTotal
				d.Jobs.MaxBillPaise = max(d.Jobs.MaxBillPaise, j.PriceTotal)
				who := staffRow(firstNonEmpty(j.CollectedBy, j.ClaimedBy))
				switch j.PaidMethod {
				case "cash":
					d.Earnings.CashPaise += j.PriceTotal
					who.CashPaise += j.PriceTotal
				case "upi":
					d.Earnings.UPIPaise += j.PriceTotal
					who.UPIPaise += j.PriceTotal
				default:
					d.Earnings.UnrecordedPaise += j.PriceTotal
					d.Earnings.UnrecordedJobs++
				}
				if j.NoReceipt {
					d.Problems.NoReceipt++
				}
				if j.ReadyAt != nil && j.CollectedAt.After(*j.ReadyAt) {
					pickupSum += int64(j.CollectedAt.Sub(*j.ReadyAt).Seconds())
					pickupN++
				}
			}
			if inPrev(j.CollectedAt) {
				d.Previous.Paise += j.PriceTotal
				d.Previous.Jobs++
			}
			if i, ok := seriesIdx[cday]; ok {
				d.Series[i].Paise += j.PriceTotal
				d.Series[i].Jobs++
			}
			if i, ok := prevIdx[cday]; ok {
				d.Series[i].PrevPaise += j.PriceTotal
				d.Series[i].PrevJobs++
			}
		}

		// Cancelled in the period.
		if j.State == domain.JobStateCancelled && period[dayOf(j.CancelledAt)] {
			d.Jobs.Cancelled++
			switch j.CancelReason {
			case cancelCustomer:
				d.Problems.CancelledByCustomer++
			case cancelNotCollected:
				d.Problems.NotCollected++
			default:
				d.Problems.CancelledByShop++
			}
		}

		// Printed (marked ready) in the period: pages, speed, staff.
		if j.ReadyAt != nil && period[dayOf(j.ReadyAt)] {
			pages := addPages(&d.Pages, j)
			if j.ClaimedAt != nil && !j.ClaimedAt.Before(*j.QueuedAt) {
				waitSum += int64(j.ClaimedAt.Sub(*j.QueuedAt).Seconds())
				waitN++
			}
			if j.ClaimedAt != nil && j.ReadyAt.After(*j.ClaimedAt) {
				secs := int64(j.ReadyAt.Sub(*j.ClaimedAt).Seconds())
				printSum += secs
				printN++
				printSecs[firstNonEmpty(j.ClaimedBy, "—")] += secs
			}
			if j.ReadyAt.Sub(*j.QueuedAt) <= quickReady {
				quick++
			}
			if j.ReadyAt.Sub(*j.QueuedAt) > longWait {
				d.Problems.LongWaits++
			}
			r := staffRow(j.ClaimedBy)
			r.Jobs++
			r.Pages += pages
		}

		for _, f := range j.Files {
			if f.DeletedAt != nil && period[dayOf(f.DeletedAt)] {
				d.FilesDeleted++
			}
		}
	}

	if d.Jobs.Collected > 0 {
		d.Jobs.AvgBillPaise = d.Earnings.TotalPaise / int64(d.Jobs.Collected)
	}
	d.Speed = SpeedStats{WaitSec: avg(waitSum, waitN), PrintSec: avg(printSum, printN), PickupSec: avg(pickupSum, pickupN)}
	readyN := 0
	for _, r := range staff {
		readyN += r.Jobs
	}
	d.Speed.Samples = readyN
	if readyN > 0 {
		d.Speed.WithinTenPct = int(float64(quick)*100/float64(readyN) + 0.5)
	}

	for name, r := range staff {
		if r.Jobs > 0 {
			r.AvgPrintSec = int(printSecs[name] / int64(r.Jobs))
		}
		d.Staff = append(d.Staff, *r)
	}
	sort.Slice(d.Staff, func(a, b int) bool {
		if d.Staff[a].Jobs != d.Staff[b].Jobs {
			return d.Staff[a].Jobs > d.Staff[b].Jobs
		}
		return d.Staff[a].Name < d.Staff[b].Name
	})
	if d.Staff == nil {
		d.Staff = []StaffRow{}
	}

	// Right now.
	var oldest *domain.Job
	for i := range in.Open {
		j := &in.Open[i]
		switch j.State {
		case domain.JobStateQueued:
			d.Now.InLine++
		case domain.JobStateClaimed:
			d.Now.Printing++
		case domain.JobStateReady:
			d.Now.Ready++
			if j.ReadyAt != nil && (oldest == nil || j.ReadyAt.Before(*oldest.ReadyAt)) {
				oldest = j
			}
		}
		if j.PagesToConfirm {
			d.Now.PagesToConfirm++
		}
	}
	if oldest != nil {
		d.Now.OldestReadyToken = oldest.Token
		d.Now.OldestReadyMin = int(in.Now.Sub(*oldest.ReadyAt).Minutes())
	}
	d.Now.CopiesToConfirm = in.CopiesToConfirm
	return d
}

// addPages adds a printed job's files to the page stats and returns its printed pages.
func addPages(p *PageStats, j domain.Job) int {
	total := 0
	for _, f := range j.Files {
		s := f.Settings
		if s.Other {
			p.OtherFiles++
			continue
		}
		switch domain.FileKind(f.Mime) {
		case "image":
			p.PhotoFiles++
		case "pdf":
			p.PDFFiles++
		default:
			p.DocFiles++
		}
		if f.Pages <= 0 {
			continue
		}
		n := f.Pages
		if sel, err := domain.ParsePageRange(s.PageRange, f.Pages); err == nil {
			n = len(sel)
		}
		copies := max(s.Copies, 1)
		printed := n * copies
		total += printed
		p.Printed += printed
		if s.Colour {
			p.Colour += printed
		} else {
			p.BW += printed
		}
		if s.BothSides {
			p.BothSides += printed
			p.Sheets += (n + 1) / 2 * copies
		} else {
			p.OneSide += printed
			p.Sheets += printed
		}
	}
	if j.OtherPrice != nil {
		p.OtherPaise += *j.OtherPrice
	}
	return total
}

func toSet(days []string) map[string]bool {
	m := make(map[string]bool, len(days))
	for _, d := range days {
		m[d] = true
	}
	return m
}

func avg(sum int64, n int) int {
	if n == 0 {
		return 0
	}
	return int(sum / int64(n))
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
