package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Orders are multi-day jobs — college blackbooks, theses, binding, bulk printing, visiting cards,
// banners and so on (see Catalogue): the shop quotes a price, takes an advance, works on it over a
// few days and collects the balance on delivery. They live beside print jobs, with their own
// states, and never enter the print queue.
//
// Counter Drop only records what was paid at the counter (cash or the shop's own UPI); it never
// holds money (BR-M1, BR-M6).

type OrderState string

const (
	OrderDraft     OrderState = "draft"     // the student is still uploading; the shop can't see it
	OrderRequested OrderState = "requested" // the student sent it; the shop hasn't quoted yet
	OrderQuoted    OrderState = "quoted"    // price set; waiting for the advance
	OrderConfirmed OrderState = "confirmed" // advance taken (or waived); work can start
	OrderPrinting  OrderState = "printing"
	OrderBinding   OrderState = "binding" // with the binder / being finished
	OrderReady     OrderState = "ready"
	OrderDelivered OrderState = "delivered"
	OrderCancelled OrderState = "cancelled"
)

// Open reports whether the order is still being worked on.
func (s OrderState) Open() bool { return s != OrderDelivered && s != OrderCancelled }

// Visible reports whether the shop sees the order (everything except drafts).
func (s OrderState) Visible() bool { return s != OrderDraft }

// stageRank orders the working states, so staff can move forward (or one step back to fix a slip).
var stageRank = map[OrderState]int{OrderConfirmed: 0, OrderPrinting: 1, OrderBinding: 2, OrderReady: 3}

const (
	BindingHard   = "hard"   // black hard binding with gold lettering (the classic blackbook)
	BindingSpiral = "spiral" // spiral / comb
	BindingSoft   = "soft"   // soft cover (thermal / tape)
	BindingNone   = "none"   // loose sheets (bulk printing)
)

var bindingNames = map[string]string{BindingHard: "Black hard binding, gold lettering", BindingSpiral: "Spiral binding", BindingSoft: "Soft cover binding", BindingNone: "No binding"}

func BindingName(b string) string { return bindingNames[b] }

const (
	PayAdvance = "advance"
	PayBalance = "balance"
	PayRefund  = "refund"
)

// OrderSettings is the shop's order price list (paise), services and defaults.
type OrderSettings struct {
	Enabled        bool             `json:"enabled"`        // take orders online (customers see "Order something")
	HardPaise      int64            `json:"hardPaise"`      // binding per copy, incl. gold lettering on cover and spine
	SpiralPaise    int64            `json:"spiralPaise"`    // per copy
	SoftPaise      int64            `json:"softPaise"`      // per copy
	AdvancePercent int              `json:"advancePercent"` // default advance asked for (0–100)
	Services       []ServiceSetting `json:"services"`       // one per catalogue service
}

func DefaultOrderSettings() OrderSettings {
	return OrderSettings{Enabled: true, HardPaise: 25000, SpiralPaise: 5000, SoftPaise: 8000, AdvancePercent: 50, Services: defaultServiceSettings()}
}

// Normalise fills a never-set list with the defaults and keeps exactly one setting per service.
func (o OrderSettings) Normalise() OrderSettings {
	if !o.Enabled && o.HardPaise == 0 && o.SpiralPaise == 0 && o.SoftPaise == 0 && o.AdvancePercent == 0 && len(o.Services) == 0 {
		return DefaultOrderSettings()
	}
	o.Services = normaliseServices(o.Services)
	return o
}

func (o OrderSettings) Validate() error {
	if err := validateServices(o.Services); err != nil {
		return err
	}
	for _, v := range []int64{o.HardPaise, o.SpiralPaise, o.SoftPaise} {
		if v < 0 || v > 500000 {
			return fmt.Errorf("%w: binding prices must be between ₹0 and ₹5,000", ErrValidation)
		}
	}
	if o.AdvancePercent < 0 || o.AdvancePercent > 100 {
		return fmt.Errorf("%w: advance must be 0 to 100%%", ErrValidation)
	}
	return nil
}

func (o OrderSettings) BindingPaise(b string) int64 {
	switch b {
	case BindingHard:
		return o.HardPaise
	case BindingSpiral:
		return o.SpiralPaise
	case BindingSoft:
		return o.SoftPaise
	}
	return 0
}

// CoverText is the proof the customer approves: for blackbooks and theses the cover and spine
// text (gold letters), for cards, stamps and banners the words to print (Text). Mistakes here are
// expensive, so work stops at the service's ProofBefore stage until it is approved.
type CoverText struct {
	Title   string `json:"title"`
	Student string `json:"student"`
	RollNo  string `json:"rollNo,omitempty"`
	Course  string `json:"course,omitempty"` // e.g. "T.Y.B.Com (Accounting & Finance)"
	College string `json:"college"`
	Guide   string `json:"guide,omitempty"`
	Year    string `json:"year,omitempty"` // e.g. "2026–27"
	Spine   string `json:"spine,omitempty"`
	Extra   string `json:"extra,omitempty"` // anything else for the cover
	Text    string `json:"text,omitempty"`  // the words to print (cards, stamps, banners); keeps line breaks
}

func (c CoverText) trimmed() CoverText {
	t := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	lines := strings.Split(strings.ReplaceAll(c.Text, "\r\n", "\n"), "\n")
	for i := range lines {
		lines[i] = t(lines[i])
	}
	return CoverText{Title: t(c.Title), Student: t(c.Student), RollNo: t(c.RollNo), Course: t(c.Course), College: t(c.College),
		Guide: t(c.Guide), Year: t(c.Year), Spine: t(c.Spine), Extra: t(c.Extra), Text: strings.TrimSpace(strings.Join(lines, "\n"))}
}

// Empty reports whether nothing was given.
func (c CoverText) Empty() bool { return c.trimmed() == CoverText{} }

// Validate checks the proof for the given kind (ProofCover, ProofText or none) and returns it tidied.
func (c CoverText) Validate(proof string) (CoverText, error) {
	c = c.trimmed()
	switch proof {
	case ProofCover:
		if c.Title == "" || c.Student == "" || c.College == "" {
			return c, fmt.Errorf("%w: title, student name and college are needed for the cover", ErrValidation)
		}
		c.Text = ""
	case ProofText:
		if c.Text == "" {
			return c, fmt.Errorf("%w: write the text to print (name, phone, address…)", ErrValidation)
		}
		c = CoverText{Text: c.Text}
	default:
		c = CoverText{Text: c.Text}
	}
	for _, f := range []string{c.Title, c.Student, c.RollNo, c.Course, c.College, c.Guide, c.Year, c.Spine, c.Extra} {
		if utf8.RuneCountInString(f) > 200 {
			return c, fmt.Errorf("%w: keep each cover line under 200 characters", ErrValidation)
		}
	}
	if utf8.RuneCountInString(c.Text) > 1000 {
		return c, fmt.Errorf("%w: keep the text under 1,000 characters", ErrValidation)
	}
	return c, nil
}

// OrderSpec is what to make. Document services use copies, binding and the printing details;
// quantity services use Quantity and Size; "Something else" uses Description.
type OrderSpec struct {
	Copies      int    `json:"copies,omitempty"`
	Binding     string `json:"binding,omitempty"`
	BothSides   bool   `json:"bothSides,omitempty"`
	ColourPages string `json:"colourPages,omitempty"` // e.g. "5,12-14"; the rest in B/W
	Pages       int    `json:"pages,omitempty"`       // pages in one copy (0 = shop will count)
	Quantity    int    `json:"quantity,omitempty"`    // cards, sq ft, photos… (quantity services)
	Size        string `json:"size,omitempty"`        // e.g. "6 × 3 ft", "4×6 in", "A4"
	Description string `json:"description,omitempty"` // what is wanted ("Something else")
	Notes       string `json:"notes,omitempty"`
}

// Validate checks the spec for a service and returns it tidied (fields the service doesn't use are cleared).
func (s OrderSpec) Validate(svc Service) (OrderSpec, error) {
	clean := func(v string) string { return strings.Join(strings.Fields(v), " ") }
	out := OrderSpec{Notes: strings.TrimSpace(s.Notes)}
	if utf8.RuneCountInString(out.Notes) > 500 {
		return out, fmt.Errorf("%w: keep notes under 500 characters", ErrValidation)
	}
	switch svc.Form {
	case FormDocument:
		out.Copies, out.Binding, out.BothSides, out.Pages = s.Copies, s.Binding, s.BothSides, s.Pages
		out.ColourPages = strings.ReplaceAll(strings.TrimSpace(s.ColourPages), " ", "")
		if out.Copies < 1 || out.Copies > 1000 {
			return out, fmt.Errorf("%w: copies must be 1 to 1000", ErrValidation)
		}
		if out.Binding == "" {
			out.Binding = svc.Binding
		}
		if bindingNames[out.Binding] == "" {
			return out, fmt.Errorf("%w: choose a binding", ErrValidation)
		}
		if out.Pages < 0 || out.Pages > 2000 {
			return out, fmt.Errorf("%w: pages must be 0 to 2000", ErrValidation)
		}
		if out.ColourPages != "" && out.Pages > 0 {
			if _, err := ParsePageRange(out.ColourPages, out.Pages); err != nil {
				return out, fmt.Errorf("%w: colour pages must look like 5,12-14 and be within %d pages", ErrValidation, out.Pages)
			}
		}
	case FormQuantity:
		out.Quantity, out.Size = s.Quantity, clean(s.Size)
		if out.Quantity < 1 || out.Quantity > 100000 {
			return out, fmt.Errorf("%w: how many %s? (1 to 1,00,000)", ErrValidation, svc.Unit)
		}
		if utf8.RuneCountInString(out.Size) > 40 {
			return out, fmt.Errorf("%w: keep the size short (e.g. 6 × 3 ft)", ErrValidation)
		}
	default:
		out.Description = strings.TrimSpace(s.Description)
		if utf8.RuneCountInString(out.Description) < 3 || utf8.RuneCountInString(out.Description) > 500 {
			return out, fmt.Errorf("%w: tell the shop what you need (3 to 500 characters)", ErrValidation)
		}
	}
	return out, nil
}

// ColourCount is how many of the pages are printed in colour.
func (s OrderSpec) ColourCount() int {
	if s.ColourPages == "" || s.Pages <= 0 {
		return 0
	}
	sel, err := ParsePageRange(s.ColourPages, s.Pages)
	if err != nil {
		return 0
	}
	return len(sel)
}

// OrderLine is one line of the shop's quote.
type OrderLine struct {
	Label string `json:"label"`
	Paise int64  `json:"paise"`
}

// SuggestQuote prices an order from the shop's print rates, binding prices and service prices.
// Staff can change any line before sending the quote. "Something else" has no suggestion.
func SuggestQuote(pl PriceList, os OrderSettings, svc Service, s OrderSpec) []OrderLine {
	var lines []OrderLine
	switch svc.Form {
	case FormQuantity:
		unit := os.Service(svc.ID).UnitPaise
		if unit <= 0 || s.Quantity <= 0 {
			return nil
		}
		size := max(svc.UnitSize, 1)
		lots := (s.Quantity + size - 1) / size
		label := fmt.Sprintf("%s · %d %s (%s)", svc.Name, s.Quantity, svc.Unit, svc.UnitLabel(unit))
		return []OrderLine{{Label: label, Paise: int64(lots) * unit}}
	case FormCustom:
		return nil
	}
	if s.Pages > 0 {
		colour := s.ColourCount()
		bw := s.Pages - colour
		rate := func(one, both int64) int64 { // per printed page
			if s.BothSides {
				if both == 0 {
					both = 2 * one
				}
				return both / 2
			}
			return one
		}
		if bw > 0 {
			lines = append(lines, OrderLine{Label: fmt.Sprintf("Printing B/W · %d pages × %d", bw, s.Copies), Paise: int64(bw*s.Copies) * rate(pl.BWOne, pl.BWBoth)})
		}
		if colour > 0 {
			lines = append(lines, OrderLine{Label: fmt.Sprintf("Printing colour · %d pages × %d", colour, s.Copies), Paise: int64(colour*s.Copies) * rate(pl.ColourOne, pl.ColourBoth)})
		}
	}
	if p := os.BindingPaise(s.Binding); p > 0 {
		lines = append(lines, OrderLine{Label: fmt.Sprintf("%s × %d", BindingName(s.Binding), s.Copies), Paise: int64(s.Copies) * p})
	}
	return lines
}

// MaxOrderPaise caps one order (₹1,00,000).
const MaxOrderPaise = 1_00_000_00

func ValidateLines(lines []OrderLine) ([]OrderLine, int64, error) {
	if len(lines) == 0 || len(lines) > 20 {
		return nil, 0, fmt.Errorf("%w: add 1 to 20 price lines", ErrValidation)
	}
	var total int64
	out := make([]OrderLine, 0, len(lines))
	for _, l := range lines {
		l.Label = strings.TrimSpace(l.Label)
		if l.Label == "" || utf8.RuneCountInString(l.Label) > 80 {
			return nil, 0, fmt.Errorf("%w: each price line needs a short name", ErrValidation)
		}
		if l.Paise < 0 || l.Paise > MaxOrderPaise {
			return nil, 0, fmt.Errorf("%w: price lines must be between ₹0 and ₹1,00,000", ErrValidation)
		}
		total += l.Paise
		out = append(out, l)
	}
	if total <= 0 || total > MaxOrderPaise {
		return nil, 0, fmt.Errorf("%w: total must be between ₹1 and ₹1,00,000", ErrValidation)
	}
	return out, total, nil
}

// OrderPayment is money recorded at the counter. Refunds are negative.
type OrderPayment struct {
	ID     string    `json:"id"`
	Kind   string    `json:"kind"`   // advance | balance | refund
	Method string    `json:"method"` // cash | upi
	Paise  int64     `json:"paise"`
	At     time.Time `json:"at"`
	By     string    `json:"by"`
}

// OrderEvent is one line of the order's history (shown to staff and, in plain words, the customer).
type OrderEvent struct {
	At     time.Time `json:"at"`
	Action string    `json:"action"`
	By     string    `json:"by,omitempty"`
	Note   string    `json:"note,omitempty"`
}

type Order struct {
	ID       string     `json:"id"`
	ShopID   string     `json:"shopId"`
	Code     string     `json:"code"` // short code to say at the counter, e.g. "BB-7K2Q"
	Kind     string     `json:"kind"` // "blackbook"
	State    OrderState `json:"state"`
	Channel  string     `json:"channel"` // online (student sent it) | counter (staff created it)
	Customer string     `json:"customerName,omitempty"`
	Phone    string     `json:"phone,omitempty"`
	Spec     OrderSpec  `json:"spec"`
	Cover    CoverText  `json:"cover"`
	DueDate  string     `json:"dueDate"` // YYYY-MM-DD, shop time

	Lines        []OrderLine    `json:"lines"`
	TotalPaise   int64          `json:"totalPaise"`
	AdvancePaise int64          `json:"advancePaise"` // advance asked for
	PaidPaise    int64          `json:"paidPaise"`    // net of refunds
	Payments     []OrderPayment `json:"payments"`

	CoverVersion    int        `json:"coverVersion"`
	CoverApprovedAt *time.Time `json:"coverApprovedAt,omitempty"`

	Files          []JobFile    `json:"files"`
	History        []OrderEvent `json:"history"`
	CancelReason   string       `json:"cancelReason,omitempty"`
	CreatedAt      time.Time    `json:"createdAt"`
	UpdatedAt      time.Time    `json:"updatedAt"`
	SubmittedAt    *time.Time   `json:"submittedAt,omitempty"`
	QuotedAt       *time.Time   `json:"quotedAt,omitempty"`
	ConfirmedAt    *time.Time   `json:"confirmedAt,omitempty"`
	ReadyAt        *time.Time   `json:"readyAt,omitempty"`
	DeliveredAt    *time.Time   `json:"deliveredAt,omitempty"`
	CancelledAt    *time.Time   `json:"cancelledAt,omitempty"`
	FilesDeletedAt *time.Time   `json:"filesDeletedAt,omitempty"`
	// Copies the shop downloaded (Word files, PDFs to edit) must be deleted from its computer too.
	CopiesDeletedAt *time.Time `json:"copiesDeletedAt,omitempty"`
	CopiesDeletedBy string     `json:"copiesDeletedBy,omitempty"`
}

// BalancePaise is what's still to pay (never negative).
func (o Order) BalancePaise() int64 {
	if b := o.TotalPaise - o.PaidPaise; b > 0 {
		return b
	}
	return 0
}

// Downloaded reports whether the shop saved any file to its own computer.
func (o Order) Downloaded() bool {
	for _, f := range o.Files {
		if f.Downloads > 0 {
			return true
		}
	}
	return false
}

var (
	ErrOrderState    = errors.New("order_state")
	ErrBalanceDue    = errors.New("balance_due")
	ErrCoverRequired = errors.New("cover_required")
)

func (o *Order) log(now time.Time, action, by, note string) {
	o.History = append(o.History, OrderEvent{At: now, Action: action, By: by, Note: note})
	if len(o.History) > 100 {
		o.History = o.History[len(o.History)-100:]
	}
	o.UpdatedAt = now
}

// SetQuote records the shop's price. Allowed until the order is ready; the total can't drop below
// what was already paid. A requested order becomes quoted.
func (o *Order) SetQuote(lines []OrderLine, advance int64, now time.Time, by string) error {
	if !o.State.Open() || o.State == OrderReady || o.State == OrderDraft {
		return ErrOrderState
	}
	lines, total, err := ValidateLines(lines)
	if err != nil {
		return err
	}
	if total < o.PaidPaise {
		return fmt.Errorf("%w: the total can't be less than the ₹%d already paid", ErrValidation, o.PaidPaise/100)
	}
	if advance < 0 || advance > total {
		return fmt.Errorf("%w: advance must be between ₹0 and the total", ErrValidation)
	}
	o.Lines, o.TotalPaise, o.AdvancePaise = lines, total, advance
	if o.State == OrderRequested {
		o.State = OrderQuoted
	}
	if o.QuotedAt == nil {
		o.QuotedAt = &now
	}
	o.log(now, "quoted", by, fmt.Sprintf("Total ₹%s, advance ₹%s", rupeesText(total), rupeesText(advance)))
	return nil
}

// AddPayment records cash or UPI taken at the counter (or a refund, as a negative amount).
// The first payment on a quoted order confirms it.
func (o *Order) AddPayment(p OrderPayment, now time.Time) error {
	if !o.State.Open() && p.Kind != PayRefund {
		return ErrOrderState
	}
	if o.State == OrderRequested {
		return fmt.Errorf("%w: send the quote before taking money", ErrValidation)
	}
	if p.Method != "cash" && p.Method != "upi" {
		return fmt.Errorf("%w: choose cash or UPI", ErrValidation)
	}
	switch p.Kind {
	case PayAdvance, PayBalance:
		if p.Paise <= 0 || p.Paise > o.BalancePaise() {
			return fmt.Errorf("%w: amount must be between ₹1 and the ₹%s still due", ErrValidation, rupeesText(o.BalancePaise()))
		}
	case PayRefund:
		if p.Paise >= 0 || -p.Paise > o.PaidPaise {
			return fmt.Errorf("%w: a refund can't be more than what was paid", ErrValidation)
		}
	default:
		return fmt.Errorf("%w: unknown payment kind", ErrValidation)
	}
	p.At = now
	o.Payments = append(o.Payments, p)
	o.PaidPaise += p.Paise
	if o.State == OrderQuoted && p.Kind != PayRefund {
		o.State, o.ConfirmedAt = OrderConfirmed, &now
	}
	label := map[string]string{PayAdvance: "advance_paid", PayBalance: "balance_paid", PayRefund: "refunded"}[p.Kind]
	o.log(now, label, p.By, fmt.Sprintf("₹%s %s", rupeesText(abs(p.Paise)), strings.ToUpper(p.Method)))
	return nil
}

// ConfirmWithoutAdvance starts work on a quoted order without taking money.
func (o *Order) ConfirmWithoutAdvance(now time.Time, by string) error {
	if o.State != OrderQuoted {
		return ErrOrderState
	}
	o.State, o.ConfirmedAt = OrderConfirmed, &now
	o.log(now, "confirmed", by, "Started without advance")
	return nil
}

// Service is the order's catalogue entry ("Something else" if unknown).
func (o Order) Service() Service {
	if s, ok := ServiceByID(o.Kind); ok {
		return s
	}
	s, _ := ServiceByID("other")
	return s
}

// ProofLocked reports whether work has passed the point where the proof had to be approved, so it
// can no longer change.
func (o Order) ProofLocked() bool {
	svc := o.Service()
	if svc.Proof == ProofNone {
		return false
	}
	cur, ok := stageRank[o.State]
	return ok && cur >= stageRank[svc.ProofBefore]
}

// SetStage moves a confirmed order through printing → binding/finishing → ready (or one step back).
// Services with a proof can't pass their ProofBefore stage until the customer approved it.
func (o *Order) SetStage(to OrderState, now time.Time, by string) error {
	from, okFrom := stageRank[o.State]
	dest, okTo := stageRank[to]
	if !okFrom || !okTo || to == OrderConfirmed || dest == from || dest < from-1 {
		return ErrOrderState
	}
	if svc := o.Service(); svc.Proof != ProofNone && dest > from && dest >= stageRank[svc.ProofBefore] && o.CoverApprovedAt == nil {
		return ErrCoverRequired
	}
	o.State = to
	if to == OrderReady {
		o.ReadyAt = &now
	} else {
		o.ReadyAt = nil
	}
	o.log(now, string(to), by, "")
	return nil
}

// Deliver hands the order over. Any balance must be collected in the same step (paid ≠ "").
func (o *Order) Deliver(method string, now time.Time, by, payID string) error {
	if o.State != OrderReady {
		return ErrOrderState
	}
	if due := o.BalancePaise(); due > 0 {
		if method == "" {
			return ErrBalanceDue
		}
		if err := o.AddPayment(OrderPayment{ID: payID, Kind: PayBalance, Method: method, Paise: due, By: by}, now); err != nil {
			return err
		}
	}
	o.State, o.DeliveredAt = OrderDelivered, &now
	o.log(now, "delivered", by, "")
	return nil
}

// Cancel closes the order. With refundMethod set, everything paid is refunded first; otherwise
// the shop keeps the advance (recorded in the history).
func (o *Order) Cancel(reason, refundMethod string, now time.Time, by, payID string) error {
	if !o.State.Open() {
		return ErrOrderState
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || utf8.RuneCountInString(reason) > 140 {
		return ErrReasonRequired
	}
	note := reason
	if o.PaidPaise > 0 {
		if refundMethod != "" {
			if err := o.AddPayment(OrderPayment{ID: payID, Kind: PayRefund, Method: refundMethod, Paise: -o.PaidPaise, By: by}, now); err != nil {
				return err
			}
		} else {
			note += fmt.Sprintf(" · shop kept the ₹%s advance", rupeesText(o.PaidPaise))
		}
	}
	o.State, o.CancelledAt, o.CancelReason = OrderCancelled, &now, reason
	o.log(now, "cancelled", by, note)
	return nil
}

// SetCover replaces the proof (cover text or the words to print). Any change clears the customer's
// approval. It can't change once work has passed the proof stage.
func (o *Order) SetCover(c CoverText, now time.Time, by string) error {
	if !o.State.Open() || o.State == OrderReady || o.ProofLocked() {
		return ErrOrderState
	}
	c, err := c.Validate(o.Service().Proof)
	if err != nil {
		return err
	}
	if c == o.Cover {
		return nil
	}
	o.Cover = c
	o.CoverVersion++
	o.CoverApprovedAt = nil
	o.log(now, "cover_changed", by, "")
	return nil
}

// ApproveCover records the customer's OK for a specific version of the proof.
func (o *Order) ApproveCover(version int, now time.Time) error {
	if !o.State.Open() || o.Service().Proof == ProofNone {
		return ErrOrderState
	}
	if version != o.CoverVersion {
		return fmt.Errorf("%w: the cover text changed — check it again", ErrValidation)
	}
	if o.CoverApprovedAt != nil {
		return nil
	}
	o.CoverApprovedAt = &now
	o.log(now, "cover_approved", "customer", "")
	return nil
}

// ValidDueDate checks a YYYY-MM-DD date is no earlier than today + leadDays (shop time) and
// within 90 days. Staff may set any date from today.
func ValidDueDate(day string, now time.Time, loc *time.Location, leadDays int) error {
	d, err := time.ParseInLocation("2006-01-02", day, loc)
	if err != nil {
		return fmt.Errorf("%w: choose a delivery date", ErrValidation)
	}
	local := now.In(loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	if d.Before(today.AddDate(0, 0, leadDays)) {
		if leadDays == 0 {
			return fmt.Errorf("%w: the delivery date can't be in the past", ErrValidation)
		}
		return fmt.Errorf("%w: the shop needs at least %d days — choose %s or later", ErrValidation, leadDays, today.AddDate(0, 0, leadDays).Format("2 Jan"))
	}
	if d.After(today.AddDate(0, 0, 90)) {
		return fmt.Errorf("%w: choose a date within 90 days", ErrValidation)
	}
	return nil
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// rupeesText renders paise as "1,250" or "1,250.50" (Indian grouping).
func rupeesText(paise int64) string {
	neg := paise < 0
	paise = abs(paise)
	r, p := paise/100, paise%100
	s := fmt.Sprint(r)
	if len(s) > 3 {
		head, tail := s[:len(s)-3], s[len(s)-3:]
		var parts []string
		for len(head) > 2 {
			parts = append([]string{head[len(head)-2:]}, parts...)
			head = head[:len(head)-2]
		}
		if head != "" {
			parts = append([]string{head}, parts...)
		}
		s = strings.Join(parts, ",") + "," + tail
	}
	if p != 0 {
		s += fmt.Sprintf(".%02d", p)
	}
	if neg {
		s = "-" + s
	}
	return s
}
