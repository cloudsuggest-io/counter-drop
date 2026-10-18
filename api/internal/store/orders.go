package store

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"strings"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/storage"
)

// Order file retention (replaces BR-D2's 24 hours for orders only; the student agrees to it).
// Files are kept only while the shop still needs them:
//   - still uploading (draft): deleted after OrderDraftHours;
//   - sent: kept at most OrderFileDays, so the shop can see the file, quote and start;
//   - printing done (staff move it to binding or ready): deleted OrderReprintHours later, leaving
//     time for a quick reprint;
//   - delivered or cancelled: deleted at once.
//
// The student can delete them early only until the shop starts work (confirmed onwards).
const (
	OrderFileDays     = 7
	OrderDraftHours   = 24
	OrderReprintHours = 24
)

// StudentCanDeleteFiles: before the shop confirms the order, the student may delete their files;
// once the shop is working on it, they are deleted automatically after printing instead.
func StudentCanDeleteFiles(s domain.OrderState) bool {
	return s == domain.OrderDraft || s == domain.OrderRequested || s == domain.OrderQuoted
}

// NewOrderFile builds the record for a file the customer is about to upload to an order.
func NewOrderFile(shopID, orderID string, f NewFile, now time.Time) (domain.JobFile, error) {
	id := NewID("file")
	key, err := storage.OrderFileKey(shopID, orderID, id)
	if err != nil {
		return domain.JobFile{}, err
	}
	expiry := now.Add(OrderDraftHours * time.Hour)
	out := domain.JobFile{
		ID: id, Filename: strings.TrimSpace(f.Filename), Size: f.Size, Mime: f.Mime,
		PagesStatus: domain.PagesPending, Settings: domain.DefaultFileSettings(), ObjectKey: key,
		UploadStatus: domain.UploadStatusPending, DeleteStatus: domain.DeleteStatusActive, DeleteAfter: &expiry,
	}
	if domain.FileKind(f.Mime) == "image" {
		out.PagesStatus, out.Pages = domain.PagesCounted, 1
	}
	return out, nil
}

var phonePattern = regexp.MustCompile(`^[6-9][0-9]{9}$`)

// ValidPhone accepts an Indian mobile number (optional); returns the 10 digits.
func ValidPhone(raw string) (string, error) {
	p := strings.NewReplacer(" ", "", "-", "", "+91", "").Replace(strings.TrimSpace(raw))
	if p == "" {
		return "", nil
	}
	if !phonePattern.MatchString(p) {
		return "", fmt.Errorf("%w: enter a 10-digit mobile number", domain.ErrValidation)
	}
	return p, nil
}

// OrderName checks the customer's name on an order (up to 40 characters, required).
func OrderName(raw string) (string, error) {
	n := strings.Join(strings.Fields(raw), " ")
	if n == "" || len([]rune(n)) > 40 {
		return "", fmt.Errorf("%w: enter a name (up to 40 characters)", domain.ErrValidation)
	}
	return n, nil
}

// OrderCode is a short code to say at the counter: "OR-" and four letters/digits that can't be
// confused (no 0/O, 1/I).
func OrderCode() string {
	const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return "OR-" + string(b)
}

// ValidateNewOrder checks a new order and returns it tidied.
func ValidateNewOrder(sh domain.Shop, in CreateOrderInput, lim Limits, now time.Time) (CreateOrderInput, error) {
	var err error
	svc, ok := domain.ServiceByID(in.Service)
	if !ok {
		return in, fmt.Errorf("%w: choose what you need", domain.ErrValidation)
	}
	setting := sh.Orders.Service(svc.ID)
	if in.Customer, err = OrderName(in.Customer); err != nil {
		return in, err
	}
	if in.Phone, err = ValidPhone(in.Phone); err != nil {
		return in, err
	}
	if in.Spec, err = in.Spec.Validate(svc); err != nil {
		return in, err
	}
	// Staff may take an order before the proof text is known; the customer adds it from the link.
	proof := svc.Proof
	if in.Staff != "" && in.Cover.Empty() {
		proof = domain.ProofNone
	}
	if in.Cover, err = in.Cover.Validate(proof); err != nil {
		return in, err
	}
	lead := setting.LeadDays
	if in.Staff != "" {
		lead = 0 // the shop can promise any date
	}
	if err := domain.ValidDueDate(in.DueDate, now, sh.Location(), lead); err != nil {
		return in, err
	}
	if in.Staff == "" {
		if !sh.Orders.Enabled || !setting.Enabled {
			return in, fmt.Errorf("%w: this shop isn't taking %s orders online", domain.ErrValidation, strings.ToLower(svc.Name))
		}
		if svc.Form == domain.FormDocument && len(in.Files) == 0 {
			return in, fmt.Errorf("%w: add your file", domain.ErrValidation)
		}
	}
	if len(in.Files) > 0 {
		if err := ValidateFiles(in.Files, lim, 0, 0); err != nil {
			return in, err
		}
	}
	return in, nil
}
