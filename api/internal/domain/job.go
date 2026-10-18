package domain

import (
	"errors"
	"fmt"
	"time"
)

// JobState is the lifecycle state of a print job (FSD §8, walk-in subset for R1a).
type JobState string

const (
	JobStateUploading JobState = "uploading" // draft: files uploading, not visible to the shop
	JobStateQueued    JobState = "queued"    // in a lane, waiting to be claimed
	JobStateClaimed   JobState = "claimed"   // a counter is printing it
	JobStateReady     JobState = "ready"     // printed, waiting for pickup
	JobStateCollected JobState = "collected" // handed over; undo window open, files deleted after it
	JobStateCancelled JobState = "cancelled"
)

// ParseJobState accepts the legacy "new" value as an alias of queued.
func ParseJobState(s string) JobState {
	if s == "new" {
		return JobStateQueued
	}
	return JobState(s)
}

func (s JobState) IsTerminal() bool {
	return s == JobStateCollected || s == JobStateCancelled
}

type Channel string

const (
	ChannelWalkIn Channel = "walkin"
	ChannelRemote Channel = "remote" // R1b
)

type UploadStatus string

const (
	UploadStatusPending  UploadStatus = "pending"
	UploadStatusUploaded UploadStatus = "uploaded"
)

type DeleteStatus string

const (
	DeleteStatusActive  DeleteStatus = "active"
	DeleteStatusPending DeleteStatus = "pending"
	DeleteStatusDeleted DeleteStatus = "deleted"
	DeleteStatusFailed  DeleteStatus = "failed"
)

type PagesStatus string

const (
	PagesPending PagesStatus = "pending"
	PagesCounted PagesStatus = "counted"
	PagesUnknown PagesStatus = "unknown"
	// PagesConfirmed: the phone couldn't count the pages (Word, Excel…); staff entered them.
	PagesConfirmed PagesStatus = "confirmed"
)

var (
	ErrInvalidTransition = errors.New("invalid job state transition")
	ErrReasonRequired    = errors.New("reason required")
	ErrWindowExpired     = errors.New("undo window expired")
	ErrWrongActor        = errors.New("actor not allowed")
)

type JobFile struct {
	ID           string       `json:"id"`
	Filename     string       `json:"filename"`
	Size         int64        `json:"size"`
	Mime         string       `json:"mime"`
	Pages        int          `json:"pages"`
	PagesStatus  PagesStatus  `json:"pagesStatus"`
	Settings     FileSettings `json:"settings"`
	ObjectKey    string       `json:"-"`
	UploadStatus UploadStatus `json:"uploadStatus"`
	DeleteStatus DeleteStatus `json:"deleteStatus"`
	DeleteAfter  *time.Time   `json:"deleteAfter,omitempty"`
	DeletedAt    *time.Time   `json:"deletedAt,omitempty"`

	// What the shop did with the file. Downloads are shown to the customer.
	PrintedAt    *time.Time `json:"printedAt,omitempty"`
	PrintOpens   int        `json:"printOpens"`
	DownloadedAt *time.Time `json:"downloadedAt,omitempty"`
	DownloadedBy string     `json:"downloadedBy,omitempty"`
	Downloads    int        `json:"downloads"`
}

type Job struct {
	ID             string     `json:"id"`
	ShopID         string     `json:"shopId"`
	Channel        Channel    `json:"channel"`
	LaneID         string     `json:"laneId,omitempty"`
	Lane           string     `json:"lane,omitempty"`
	Token          string     `json:"token,omitempty"`
	CustomerName   string     `json:"customerName,omitempty"`
	Files          []JobFile  `json:"files"`
	State          JobState   `json:"state"`
	PriceTotal     int64      `json:"priceTotalPaise"`
	PagesTotal     int        `json:"pagesTotal"`
	PagesToConfirm bool       `json:"pagesToConfirm"`
	ReadyBy        *time.Time `json:"readyBy,omitempty"`
	ClaimedBy      string     `json:"claimedBy,omitempty"`
	CollectedBy    string     `json:"collectedBy,omitempty"` // staff who marked it collected (took the payment)
	CancelReason   string     `json:"cancelReason,omitempty"`
	PaidMethod     string     `json:"paidMethod,omitempty"`
	// OtherPrice is what the shop charged for Other files (set when marking ready); it is
	// included in PriceTotal. Nil until the shop sets it.
	OtherPrice     *int64     `json:"otherPricePaise,omitempty"`
	NoReceipt      bool       `json:"noReceipt,omitempty"` // the shop chose not to give a receipt
	BusinessDay    string     `json:"businessDay,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	QueuedAt       *time.Time `json:"queuedAt,omitempty"`
	ClaimedAt      *time.Time `json:"claimedAt,omitempty"`
	ReadyAt        *time.Time `json:"readyAt,omitempty"`
	CollectedAt    *time.Time `json:"collectedAt,omitempty"`
	CancelledAt    *time.Time `json:"cancelledAt,omitempty"`
	FilesDeletedAt *time.Time `json:"filesDeletedAt,omitempty"`

	// Copies the shop downloaded: the customer can ask for them to be deleted; the shop confirms.
	CopiesDeleteRequestedAt *time.Time `json:"copiesDeleteRequestedAt,omitempty"`
	CopiesDeletedAt         *time.Time `json:"copiesDeletedAt,omitempty"`
	CopiesDeletedBy         string     `json:"copiesDeletedBy,omitempty"`
}

// HasOther reports whether any live file was sent for something other than printing.
func (j Job) HasOther() bool {
	for _, f := range j.Files {
		if f.Settings.Other && f.DeleteStatus == DeleteStatusActive {
			return true
		}
	}
	return false
}

// MaxOtherPrice caps what the shop can charge for Other files (₹50,000).
const MaxOtherPrice = 50_000_00

// SetOtherPrice records the shop's price for Other files and folds it into the job total.
func (j *Job) SetOtherPrice(paise int64) error {
	if paise < 0 || paise > MaxOtherPrice {
		return fmt.Errorf("%w: price must be between ₹0 and ₹50,000", ErrValidation)
	}
	prev := int64(0)
	if j.OtherPrice != nil {
		prev = *j.OtherPrice
	}
	j.PriceTotal = j.PriceTotal - prev + paise
	j.OtherPrice = &paise
	return nil
}

// Downloaded reports whether the shop saved any of the job's files to its own device.
func (j Job) Downloaded() bool {
	for _, f := range j.Files {
		if f.Downloads > 0 {
			return true
		}
	}
	return false
}

// Action is something a customer, staff member or the system does to a job.
type Action string

const (
	ActionSubmit    Action = "submit"
	ActionClaim     Action = "claim"
	ActionRelease   Action = "release"
	ActionReady     Action = "ready"
	ActionCollected Action = "collected"
	ActionUndo      Action = "undo"
	ActionCancel    Action = "cancel"
	ActionEdit      Action = "edit"
	ActionAbandon   Action = "abandon"
)

type ActorType string

const (
	ActorGuest  ActorType = "guest"
	ActorStaff  ActorType = "staff"
	ActorSystem ActorType = "system"
)

type Actor struct {
	Type ActorType
	ID   string
	Name string
}

// Policy holds configurable timings.
type Policy struct {
	UndoWindow   time.Duration // collected → files deleted after this; undo allowed within it
	AbandonAfter time.Duration // uploading drafts older than this are cancelled
}

func DefaultPolicy() Policy {
	return Policy{UndoWindow: 10 * time.Minute, AbandonAfter: 60 * time.Minute}
}

// Effects the caller must carry out after a successful transition.
type Effects struct {
	IssueToken     bool       // assign lane + daily token (submit)
	ScheduleDelete *time.Time // set delete_after on remaining files
	ClearDelete    bool       // undo: the job is active again, so its files are kept
}

// Transition applies an action to a job. It is pure: it mutates only the given job value
// and returns the effects the store must execute in the same transaction.
func Transition(job *Job, action Action, actor Actor, reason string, now time.Time, p Policy) (Effects, error) {
	var fx Effects
	from := job.State

	switch action {
	case ActionSubmit:
		if from != JobStateUploading || actor.Type != ActorGuest {
			return fx, ErrInvalidTransition
		}
		job.State = JobStateQueued
		job.QueuedAt = &now
		fx.IssueToken = true

	case ActionEdit:
		if !(from == JobStateUploading || from == JobStateQueued) {
			return fx, ErrInvalidTransition
		}

	case ActionClaim:
		if from != JobStateQueued || actor.Type != ActorStaff {
			return fx, ErrInvalidTransition
		}
		job.State = JobStateClaimed
		job.ClaimedAt = &now
		job.ClaimedBy = actor.Name

	case ActionRelease:
		if from != JobStateClaimed || actor.Type != ActorStaff {
			return fx, ErrInvalidTransition
		}
		job.State = JobStateQueued // keeps QueuedAt, so it returns to the head of its lane
		job.ClaimedAt = nil
		job.ClaimedBy = ""

	case ActionReady:
		if from != JobStateClaimed || actor.Type != ActorStaff {
			return fx, ErrInvalidTransition
		}
		job.State = JobStateReady
		job.ReadyAt = &now

	case ActionCollected:
		if from != JobStateReady || actor.Type != ActorStaff {
			return fx, ErrInvalidTransition
		}
		job.State = JobStateCollected
		job.CollectedAt = &now
		job.CollectedBy = actor.Name
		at := now.Add(p.UndoWindow)
		fx.ScheduleDelete = &at

	case ActionUndo:
		if from != JobStateCollected || actor.Type != ActorStaff {
			return fx, ErrInvalidTransition
		}
		if job.CollectedAt == nil || now.Sub(*job.CollectedAt) > p.UndoWindow || job.FilesDeletedAt != nil {
			return fx, ErrWindowExpired
		}
		job.State = JobStateReady
		job.CollectedAt = nil
		job.CollectedBy = ""
		fx.ClearDelete = true

	case ActionCancel:
		switch actor.Type {
		case ActorGuest:
			// Customers may cancel only before a counter picks the job up (BR-Q3).
			if from != JobStateUploading && from != JobStateQueued {
				return fx, ErrInvalidTransition
			}
		case ActorStaff:
			if from != JobStateQueued && from != JobStateClaimed && from != JobStateReady {
				return fx, ErrInvalidTransition
			}
			if reason == "" {
				return fx, ErrReasonRequired
			}
		case ActorSystem:
			if from.IsTerminal() {
				return fx, ErrInvalidTransition
			}
		default:
			return fx, ErrWrongActor
		}
		job.State = JobStateCancelled
		job.CancelledAt = &now
		job.CancelReason = reason
		at := now
		fx.ScheduleDelete = &at

	case ActionAbandon:
		if from != JobStateUploading || actor.Type != ActorSystem {
			return fx, ErrInvalidTransition
		}
		job.State = JobStateCancelled
		job.CancelledAt = &now
		job.CancelReason = "abandoned"
		at := now
		fx.ScheduleDelete = &at

	default:
		return fx, ErrInvalidTransition
	}

	job.UpdatedAt = now
	return fx, nil
}
