package store

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/storage"
)

// Business rules used by the store. They are pure (no I/O), so they are easy to test on their own
// and stay the same whatever database is underneath.

// ValidateNewShop normalises and checks the input for CreateShop.
func ValidateNewShop(in CreateShopInput) (CreateShopInput, error) {
	in.Slug = strings.ToLower(strings.TrimSpace(in.Slug))
	in.Name = strings.TrimSpace(in.Name)
	if !slugPattern.MatchString(in.Slug) || reservedSlugs[in.Slug] {
		return in, fmt.Errorf("%w: slug must be 3–30 lowercase letters, digits or hyphens", domain.ErrValidation)
	}
	if n := len(in.Name); n < 3 || n > 60 {
		return in, fmt.Errorf("%w: shop name must be 3–60 characters", domain.ErrValidation)
	}
	return in, nil
}

// ErrSlugTaken is returned by CreateShop when the link name is in use.
var ErrSlugTaken = fmt.Errorf("%w: that link name is taken", domain.ErrValidation)

// DefaultLanes are the lanes every new shop starts with.
func DefaultLanes() []domain.Lane {
	return []domain.Lane{
		{ID: NewID("lane"), Letter: "A", Name: "B/W", Rule: "bw"},
		{ID: NewID("lane"), Letter: "B", Name: "Colour", Rule: "colour"},
	}
}

// NewStaffRecord validates a staff member to add. An empty PIN makes them pending (setup link).
// It returns the trimmed name and the PIN hash ("" when pending).
func NewStaffRecord(name, role, pin string) (string, string, error) {
	name = strings.TrimSpace(name)
	if n := len([]rune(name)); n < 2 || n > 30 {
		return "", "", fmt.Errorf("%w: name must be 2–30 characters", domain.ErrValidation)
	}
	if role != "owner" && role != "staff" {
		return "", "", fmt.Errorf("%w: role must be owner or staff", domain.ErrValidation)
	}
	if pin == "" {
		return name, "", nil
	}
	if !pinPattern.MatchString(pin) {
		return "", "", fmt.Errorf("%w: PIN must be 4 digits", domain.ErrValidation)
	}
	hash, err := HashPIN(pin)
	return name, hash, err
}

// ErrBadPurpose is returned for a setup link purpose other than setup or reset.
var ErrBadPurpose = fmt.Errorf("%w: purpose must be setup or reset", domain.ErrValidation)

// ErrNameTaken builds the error for a duplicate active staff name.
func ErrNameTaken(name string) error {
	return fmt.Errorf("%w: someone called %q already works here", domain.ErrValidation, name)
}

// ValidateShopState checks a pause/offline change and trims the message.
func ValidateShopState(state domain.OnlineState, msg string) (string, error) {
	if state != domain.ShopOnline && state != domain.ShopPaused && state != domain.ShopOffline {
		return "", fmt.Errorf("%w: state must be online, paused or offline", domain.ErrValidation)
	}
	if len(msg) > 140 {
		msg = msg[:140]
	}
	return msg, nil
}

// ValidateSettings checks a settings update against the current shop and returns the values to store:
// the trimmed profile (hold days defaulted) and the price list with its next version.
func ValidateSettings(cur domain.Shop, p ShopProfile, prices domain.PriceList) (ShopProfile, domain.PriceList, error) {
	p.Name, p.Address = strings.TrimSpace(p.Name), strings.TrimSpace(p.Address)
	if n := len(p.Name); n < 3 || n > 60 {
		return p, prices, fmt.Errorf("%w: shop name must be 3–60 characters", domain.ErrValidation)
	}
	if !hhmm.MatchString(p.OpensAt) || !hhmm.MatchString(p.ClosesAt) || p.ClosesAt <= p.OpensAt {
		return p, prices, fmt.Errorf("%w: closing time must be after opening time (HH:MM)", domain.ErrValidation)
	}
	if err := prices.Validate(); err != nil {
		return p, prices, err
	}
	if p.HoldDays == 0 {
		p.HoldDays = cur.HoldDays
	}
	if p.HoldDays < 1 || p.HoldDays > 7 {
		return p, prices, fmt.Errorf("%w: uncollected jobs can be kept 1–7 days", domain.ErrValidation)
	}
	prices.Version = cur.Prices.Version + 1
	return p, prices, nil
}

// NewJobFile builds the record for a file the customer is about to upload.
func NewJobFile(shopID, jobID string, f NewFile) (domain.JobFile, error) {
	id := NewID("file")
	key, err := storage.FileKey(shopID, jobID, id)
	if err != nil {
		return domain.JobFile{}, err
	}
	out := domain.JobFile{
		ID: id, Filename: strings.TrimSpace(f.Filename), Size: f.Size, Mime: f.Mime,
		PagesStatus: domain.PagesPending, Settings: domain.DefaultFileSettings(), ObjectKey: key,
		UploadStatus: domain.UploadStatusPending, DeleteStatus: domain.DeleteStatusActive,
	}
	if domain.FileKind(f.Mime) == "image" {
		out.PagesStatus, out.Pages = domain.PagesCounted, 1
	}
	return out, nil
}

// UploadedPages normalises the page count reported by the client for a finished upload.
func UploadedPages(mime string, pages int) (int, domain.PagesStatus) {
	if domain.FileKind(mime) == "image" {
		return 1, domain.PagesCounted
	}
	if pages <= 0 || pages > 2000 {
		return 0, domain.PagesUnknown
	}
	return pages, domain.PagesCounted
}

// DraftFileExpiry is when a file uploaded to a draft is deleted if the job is never sent:
// today's closing time, at most 24 hours away (BR-D2).
func DraftFileExpiry(sh domain.Shop, now time.Time) time.Time {
	expiry := sh.ClosingTime(now)
	if cap := now.Add(24 * time.Hour); expiry.After(cap) || !expiry.After(now) {
		expiry = cap
	}
	return expiry
}

// SubmitCheck verifies that a draft can be sent and prices it. It returns the quote and whether
// any live file is printed in colour (which picks the lane).
func SubmitCheck(sh domain.Shop, j domain.Job, priceVersion string) (domain.Quote, bool, error) {
	live, anyColour := 0, false
	active := j
	active.Files = nil
	for _, f := range j.Files {
		if f.DeleteStatus != domain.DeleteStatusActive {
			continue
		}
		live++
		if f.UploadStatus != domain.UploadStatusUploaded {
			return domain.Quote{}, false, ErrUploadsIncomplete
		}
		anyColour = anyColour || (f.Settings.Colour && !f.Settings.Other)
		active.Files = append(active.Files, f)
	}
	if live == 0 {
		return domain.Quote{}, false, ErrUploadsIncomplete
	}
	quote, err := QuoteFor(sh, active)
	if err != nil {
		return quote, false, err
	}
	if priceVersion != "" && priceVersion != quote.PriceVersion {
		return quote, false, ErrPriceChanged
	}
	return quote, anyColour, nil
}

// ReadyBy estimates when a newly sent job will be ready: the queue wait plus its own printing time.
func ReadyBy(now time.Time, wait domain.WaitEstimate, pagesTotal int) time.Time {
	own := 3 + float64(pagesTotal)/20
	return now.Add(time.Duration(float64(wait.HighMinutes)+own) * time.Minute)
}

// EditableSettings normalises a per-file settings change and checks the shop can price it.
func EditableSettings(sh domain.Shop, f domain.JobFile, s domain.FileSettings) (domain.FileSettings, error) {
	st := domain.NormaliseSettings(s, domain.FileKind(f.Mime))
	_, err := domain.ComputeQuote(sh.Prices, []domain.QuoteFile{{ID: f.ID, Kind: domain.FileKind(f.Mime), Pages: f.Pages, Settings: st}})
	return st, err
}

// CanEdit reports whether the customer may still change the job's name and settings.
func CanEdit(j domain.Job) bool {
	return j.State == domain.JobStateUploading || (j.State == domain.JobStateQueued && j.ClaimedAt == nil)
}

// DeleteBackoff is the retry delay after a failed delete (1, 5, 15 minutes).
func DeleteBackoff(attempts int) time.Duration {
	backoff := []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}
	if attempts-1 < len(backoff) && attempts >= 1 {
		return backoff[attempts-1]
	}
	return backoff[len(backoff)-1]
}

// Lookup query parsing: "A07", "a-7" or "A 07" are tokens; anything else is a first-name prefix.
func LookupToken(q string) string {
	up := strings.ToUpper(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(q), "-", ""), " ", ""))
	if len(up) >= 2 && up[0] >= 'A' && up[0] <= 'Z' {
		var n int
		if _, err := fmt.Sscanf(up[1:], "%d", &n); err == nil && n > 0 {
			return domain.FormatToken(up[:1], n)
		}
	}
	return ""
}

// CopiesWindow is how long finished jobs with downloaded copies stay on the shop's "delete copies" list.
const CopiesWindow = 30 * 24 * time.Hour

// ActiveCounterWindow: counters that claimed a job this recently count as active for wait estimates.
const ActiveCounterWindow = 30 * time.Minute

// Session and lockout rules.
const (
	MaxPINAttempts = 5
	LockoutFor     = 15 * time.Minute
)

func ValidName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if len([]rune(name)) > 20 {
		return "", fmt.Errorf("%w: first name must be 20 characters or fewer", domain.ErrValidation)
	}
	return name, nil
}

func ValidateFiles(files []NewFile, lim Limits, existing int64, existingCount int) error {
	if len(files) == 0 {
		return fmt.Errorf("%w: choose at least one file", domain.ErrValidation)
	}
	if existingCount+len(files) > lim.MaxFiles {
		return fmt.Errorf("%w: up to %d files per job", domain.ErrValidation, lim.MaxFiles)
	}
	total := existing
	for _, f := range files {
		if !domain.AllowedMimes[f.Mime] {
			return fmt.Errorf("%w: we can print PDF, photos, Word, Excel, PowerPoint and text files", domain.ErrValidation)
		}
		if f.Size <= 0 || f.Size > lim.MaxFileBytes {
			return fmt.Errorf("%w: each file must be under %d MB", domain.ErrValidation, lim.MaxFileBytes>>20)
		}
		if n := len(strings.TrimSpace(f.Filename)); n == 0 || n > 200 {
			return fmt.Errorf("%w: file name missing or too long", domain.ErrValidation)
		}
		total += f.Size
	}
	if total > lim.MaxJobBytes {
		return fmt.Errorf("%w: files must add up to under %d MB", domain.ErrValidation, lim.MaxJobBytes>>20)
	}
	return nil
}

func ShopAccepting(sh domain.Shop, now time.Time) error {
	if sh.Status != "live" {
		return ErrNotFound
	}
	switch sh.OnlineState {
	case domain.ShopPaused:
		return ErrShopPaused
	case domain.ShopOffline:
		return ErrShopOffline
	}
	return nil
}

// QuoteFor prices the job's active files with the shop's current price list.
func QuoteFor(sh domain.Shop, j domain.Job) (domain.Quote, error) {
	var files []domain.QuoteFile
	for _, f := range j.Files {
		if f.DeletedAt != nil || (j.State == domain.JobStateUploading && f.DeleteStatus != domain.DeleteStatusActive) {
			continue
		}
		files = append(files, domain.QuoteFile{ID: f.ID, Kind: domain.FileKind(f.Mime), Pages: f.Pages, Settings: f.Settings})
	}
	return domain.ComputeQuote(sh.Prices, files)
}

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`)

var reservedSlugs = map[string]bool{"admin": true, "api": true, "shop": true, "tv": true, "s": true, "t": true, "nearby": true, "www": true, "app": true, "help": true, "scan": true}

var hhmm = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
