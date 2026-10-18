package domain

import (
	"fmt"
	"strings"
)

// Services are the kinds of multi-day order a shop takes. The catalogue is fixed in code (so the
// apps can show translated names); each shop switches services on or off and sets its own prices
// and days needed.

const (
	FormDocument = "document" // print + bind a file: pages, copies, binding, colour pages
	FormQuantity = "quantity" // so many items at a unit price: cards, banners, stamps…
	FormCustom   = "custom"   // described in words; the shop prices it

	ProofNone  = ""
	ProofCover = "cover" // cover and spine text (blackbooks, theses)
	ProofText  = "text"  // the words to print (cards, stamps, banners…)
)

type Service struct {
	ID   string `json:"id"`
	Name string `json:"name"` // English; the apps translate by ID
	Form string `json:"form"`
	// Proof is what the customer must approve before work passes ProofBefore (gold letters,
	// printed cards and stamps can't be fixed afterwards).
	Proof       string     `json:"proof,omitempty"`
	ProofBefore OrderState `json:"proofBefore,omitempty"`
	// Quantity services: price is UnitPaise for every UnitSize items (e.g. ₹300 per 100 cards).
	Unit      string `json:"unit,omitempty"` // what is counted: "cards", "sq ft"…
	UnitSize  int    `json:"unitSize,omitempty"`
	UnitPaise int64  `json:"unitPaise,omitempty"` // default price
	// Document services: the binding chosen by default ("none" for loose sheets).
	Binding  string `json:"binding,omitempty"`
	LeadDays int    `json:"leadDays"` // default days needed
	On       bool   `json:"-"`        // switched on for new shops
}

// Catalogue is every service, in the order customers see them.
var Catalogue = []Service{
	{ID: "blackbook", Name: "Blackbook / project report", Form: FormDocument, Proof: ProofCover, ProofBefore: OrderBinding, Binding: BindingHard, LeadDays: 3, On: true},
	{ID: "thesis", Name: "Thesis / dissertation", Form: FormDocument, Proof: ProofCover, ProofBefore: OrderBinding, Binding: BindingHard, LeadDays: 3, On: true},
	{ID: "binding", Name: "Binding", Form: FormDocument, Binding: BindingSpiral, LeadDays: 1, On: true},
	{ID: "bulk", Name: "Bulk printing", Form: FormDocument, Binding: BindingNone, LeadDays: 1, On: true},
	{ID: "visiting", Name: "Visiting cards", Form: FormQuantity, Proof: ProofText, ProofBefore: OrderPrinting, Unit: "cards", UnitSize: 100, UnitPaise: 30000, LeadDays: 2, On: true},
	{ID: "letterhead", Name: "Letterheads / bill books", Form: FormQuantity, Proof: ProofText, ProofBefore: OrderPrinting, Unit: "sheets", UnitSize: 100, UnitPaise: 50000, LeadDays: 3},
	{ID: "stamp", Name: "Rubber stamp", Form: FormQuantity, Proof: ProofText, ProofBefore: OrderPrinting, Unit: "stamps", UnitSize: 1, UnitPaise: 35000, LeadDays: 1},
	{ID: "invitation", Name: "Invitation / wedding cards", Form: FormQuantity, Proof: ProofText, ProofBefore: OrderPrinting, Unit: "cards", UnitSize: 100, UnitPaise: 150000, LeadDays: 4},
	{ID: "flex", Name: "Flex banner / poster", Form: FormQuantity, Proof: ProofText, ProofBefore: OrderPrinting, Unit: "sq ft", UnitSize: 1, UnitPaise: 1500, LeadDays: 1},
	{ID: "idcard", Name: "ID cards", Form: FormQuantity, Proof: ProofText, ProofBefore: OrderPrinting, Unit: "cards", UnitSize: 1, UnitPaise: 5000, LeadDays: 2},
	{ID: "lamination", Name: "Lamination (bulk)", Form: FormQuantity, Unit: "sheets", UnitSize: 1, UnitPaise: 2000, LeadDays: 1, On: true},
	{ID: "photo", Name: "Photo prints", Form: FormQuantity, Unit: "photos", UnitSize: 1, UnitPaise: 1000, LeadDays: 1, On: true},
	{ID: "scanning", Name: "Bulk scanning", Form: FormQuantity, Unit: "pages", UnitSize: 1, UnitPaise: 300, LeadDays: 1, On: true},
	{ID: "other", Name: "Something else", Form: FormCustom, LeadDays: 0, On: true},
}

// ServiceByID finds a catalogue entry.
func ServiceByID(id string) (Service, bool) {
	for _, s := range Catalogue {
		if s.ID == id {
			return s, true
		}
	}
	return Service{}, false
}

// ServiceSetting is one shop's choice for a service.
type ServiceSetting struct {
	ID        string `json:"id"`
	Enabled   bool   `json:"enabled"`
	UnitPaise int64  `json:"unitPaise,omitempty"` // quantity services
	LeadDays  int    `json:"leadDays"`
}

func defaultServiceSettings() []ServiceSetting {
	out := make([]ServiceSetting, 0, len(Catalogue))
	for _, s := range Catalogue {
		out = append(out, ServiceSetting{ID: s.ID, Enabled: s.On, UnitPaise: s.UnitPaise, LeadDays: s.LeadDays})
	}
	return out
}

// normaliseServices keeps one setting per catalogue service, in catalogue order: unknown IDs are
// dropped and services added to the catalogue later get their defaults.
func normaliseServices(in []ServiceSetting) []ServiceSetting {
	byID := map[string]ServiceSetting{}
	for _, s := range in {
		byID[s.ID] = s
	}
	out := make([]ServiceSetting, 0, len(Catalogue))
	for _, d := range defaultServiceSettings() {
		if s, ok := byID[d.ID]; ok {
			d.Enabled, d.LeadDays = s.Enabled, s.LeadDays
			if svc, _ := ServiceByID(d.ID); svc.Form == FormQuantity {
				d.UnitPaise = s.UnitPaise
			}
		}
		out = append(out, d)
	}
	return out
}

// Service returns the shop's setting for a service (zero value, not enabled, if unknown).
func (o OrderSettings) Service(id string) ServiceSetting {
	for _, s := range normaliseServices(o.Services) {
		if s.ID == id {
			return s
		}
	}
	return ServiceSetting{}
}

func validateServices(in []ServiceSetting) error {
	for _, s := range in {
		svc, ok := ServiceByID(s.ID)
		if !ok {
			return fmt.Errorf("%w: unknown service %q", ErrValidation, s.ID)
		}
		if s.LeadDays < 0 || s.LeadDays > 30 {
			return fmt.Errorf("%w: days needed for %s must be 0 to 30", ErrValidation, strings.ToLower(svc.Name))
		}
		if s.UnitPaise < 0 || s.UnitPaise > 50_000_00 {
			return fmt.Errorf("%w: price for %s must be between ₹0 and ₹50,000", ErrValidation, strings.ToLower(svc.Name))
		}
	}
	return nil
}

// UnitLabel renders "₹300 per 100 cards" style text for quote lines.
func (s Service) UnitLabel(paise int64) string {
	if s.UnitSize > 1 {
		return fmt.Sprintf("₹%s per %d %s", rupeesText(paise), s.UnitSize, s.Unit)
	}
	return fmt.Sprintf("₹%s per %s", rupeesText(paise), strings.TrimSuffix(s.Unit, "s"))
}
