package store

import (
	"errors"
	"time"

	"counter-drop/api/internal/domain"
)

// Types shared by the API, the worker, the admin CLI and the DynamoDB store.

var (
	ErrNotFound          = errors.New("not found")
	ErrBadSecret         = errors.New("invalid ticket secret")
	ErrShopPaused        = errors.New("shop is paused")
	ErrShopOffline       = errors.New("shop is offline")
	ErrAlreadyClaimed    = errors.New("job already claimed")
	ErrLaneEmpty         = errors.New("nothing to claim")
	ErrUploadsIncomplete = errors.New("uploads incomplete")
	ErrPriceChanged      = errors.New("price changed")
	ErrBadPIN            = errors.New("wrong PIN")
	ErrLocked            = errors.New("too many attempts, try again later")
	ErrUnauthorized      = errors.New("unauthorized")
	ErrNotEditable       = errors.New("job can no longer be changed")
	ErrSetupPending      = errors.New("PIN not set up yet")
	ErrLinkInvalid       = errors.New("setup link expired or already used")
	ErrWeakPIN           = errors.New("PIN too easy to guess")
	ErrSamePIN           = errors.New("new PIN is the same as the old one")
	ErrLastOwner         = errors.New("a shop needs at least one owner")
	ErrSelf              = errors.New("not allowed on your own account")
)

type NewFile struct {
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
}

type CreateJobInput struct {
	CustomerName string
	Files        []NewFile
}

type Limits struct {
	MaxFileBytes int64
	MaxJobBytes  int64
	MaxFiles     int
}

type FileSettingsUpdate struct {
	FileID   string              `json:"fileId"`
	Settings domain.FileSettings `json:"settings"`
}

type ActInput struct {
	Action domain.Action
	Actor  domain.Actor
	ShopID string // required for staff: the job must belong to this shop
	Reason string
	Paid   string // "", cash, upi — recorded on collected (reports only)
	// OtherPrice is the shop's price for Other files, required to mark such a job ready.
	OtherPrice *int64
	// Pages are the page counts staff entered (file ID → pages) for files the phone couldn't count
	// (Word, Excel…). Required on ready while the job still has pages to confirm.
	Pages     map[string]int
	NoReceipt bool // on collected: the shop chose not to give a receipt
}

type QueueSnapshot struct {
	Shop domain.Shop  `json:"shop"`
	Jobs []domain.Job `json:"jobs"`
	// Finished jobs whose files the shop downloaded and hasn't yet confirmed deleting (last 30 days).
	CopiesToDelete []domain.Job        `json:"copiesToDelete"`
	TodayCount     int                 `json:"todayCount"`
	Wait           domain.WaitEstimate `json:"wait"`
	UndoWindow     int                 `json:"undoWindowSeconds"`
	ServerTime     time.Time           `json:"serverTime"`
}

type CreateShopInput struct {
	Slug      string
	Name      string
	Address   string
	OwnerName string
	OwnerPIN  string // empty: the owner is pending and chooses a PIN with a setup link
}

type ShopProfile struct {
	Name     string `json:"name"`
	Address  string `json:"address"`
	OpensAt  string `json:"opensAt"`
	ClosesAt string `json:"closesAt"`
	HoldDays int    `json:"holdDays,omitempty"` // 0 keeps the current value
}

type Staff struct {
	ID     string `json:"id"`
	ShopID string `json:"shopId"`
	Name   string `json:"name"`
	Role   string `json:"role"`
}

type Principal struct {
	Staff     Staff
	ExpiresAt time.Time
}

// StaffMember is a staff row as the owner sees it.
type StaffMember struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Role      string     `json:"role"`
	Pending   bool       `json:"pending"` // no PIN yet: waiting for the setup link to be used
	PinSetAt  *time.Time `json:"pinSetAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

// SetupLink is returned once, when created. Token goes in the URL fragment: /shop/setup#<token>.
type SetupLink struct {
	Token     string    `json:"-"`
	Purpose   string    `json:"purpose"` // setup | reset
	ExpiresAt time.Time `json:"expiresAt"`
}

// SetupInfo is what the setup page shows before the person chooses a PIN.
type SetupInfo struct {
	ShopName  string    `json:"shopName"`
	ShopSlug  string    `json:"shopSlug"`
	StaffName string    `json:"staffName"`
	Role      string    `json:"role"`
	Purpose   string    `json:"purpose"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type DueFile struct {
	ID    string
	JobID string
	Key   string
}

type DeletionHealth struct {
	DueNow          int        `json:"dueNow"`
	Deleted24h      int        `json:"deleted24h"`
	Failed          int        `json:"failed"`
	OldestUndeleted *time.Time `json:"oldestUndeleted,omitempty"`
}
