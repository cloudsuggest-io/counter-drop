package store

import (
	"context"
	"time"

	"counter-drop/api/internal/domain"
)

// Repository is everything the API, the background worker and the admin CLI need from persistence.
// It is implemented by ddbstore.Store (DynamoDB, ADR-001); the end-to-end suite in internal/httpapi is
// its contract. Keeping it an interface also lets handlers be tested with a fake.
//
// Concurrency contract: every state change is atomic with respect to other changes of the same job
// (DynamoDB: conditional write on the job's version, retried from a fresh read).
type Repository interface {
	Ping(ctx context.Context) error
	Close()
	// SetClock replaces the clock (tests).
	SetClock(now func() time.Time)

	// Shops
	GetShopBySlug(ctx context.Context, slug string) (domain.Shop, error)
	GetShopByID(ctx context.Context, id string) (domain.Shop, error)
	CreateShop(ctx context.Context, in CreateShopInput) (domain.Shop, error)
	SeedDemo(ctx context.Context) error
	SetShopState(ctx context.Context, shopID string, state domain.OnlineState, msg string) (domain.Shop, error)
	UpdateShopSettings(ctx context.Context, shopID string, p ShopProfile, prices domain.PriceList) (domain.Shop, error)

	// Staff, sessions and setup links
	AddStaff(ctx context.Context, shopID, name, role, pin string) error
	StaffNames(ctx context.Context, slug string) ([]string, error)
	Login(ctx context.Context, slug, name, pin string, ttl time.Duration) (string, Principal, error)
	Session(ctx context.Context, token string) (Principal, error)
	Logout(ctx context.Context, token string) error
	ListStaff(ctx context.Context, shopID string) ([]StaffMember, error)
	StaffByName(ctx context.Context, shopID, name string) (StaffMember, error)
	OwnerID(ctx context.Context, shopID string) (string, error)
	InviteStaff(ctx context.Context, shopID, name, role, createdBy string, ttl time.Duration) (StaffMember, SetupLink, error)
	IssueSetupLink(ctx context.Context, shopID, staffID, purpose, createdBy string, ttl time.Duration) (SetupLink, error)
	SetupLinkInfo(ctx context.Context, token string) (SetupInfo, error)
	CompleteSetup(ctx context.Context, token, pin string, sessionTTL time.Duration) (string, Principal, error)
	ChangePIN(ctx context.Context, staffID, currentSession, currentPIN, newPIN string) error
	RemoveStaff(ctx context.Context, shopID, staffID, byStaffID string) error

	// Jobs (customer side)
	GetJob(ctx context.Context, id string) (domain.Job, error)
	VerifySecret(ctx context.Context, jobID, secret string) error
	CreateJob(ctx context.Context, sh domain.Shop, in CreateJobInput, lim Limits) (domain.Job, string, error)
	AddFiles(ctx context.Context, jobID string, files []NewFile, lim Limits) (domain.Job, error)
	FileUploaded(ctx context.Context, jobID, fileID string, pages int) (domain.JobFile, error)
	RemoveFile(ctx context.Context, jobID, fileID string) (domain.Job, error)
	UpdateJob(ctx context.Context, jobID string, name *string, files []FileSettingsUpdate) (domain.Job, error)
	Submit(ctx context.Context, jobID, priceVersion, name string) (domain.Job, domain.Quote, error)
	FileForGuest(ctx context.Context, jobID, fileID string) (domain.Job, domain.JobFile, error)
	RequestCopiesDeletion(ctx context.Context, jobID string) (domain.Job, error)

	// Jobs (shop side)
	Act(ctx context.Context, jobID string, in ActInput) (domain.Job, error)
	ClaimNext(ctx context.Context, shopID, lane string, actor domain.Actor) (domain.Job, error)
	Queue(ctx context.Context, shopID string) (QueueSnapshot, error)
	Wait(ctx context.Context, shopID string) (domain.WaitEstimate, error)
	Position(ctx context.Context, j domain.Job) (int, error)
	Lookup(ctx context.Context, shopID, q string) ([]domain.Job, error)
	FileForShop(ctx context.Context, shopID, jobID, fileID string) (domain.JobFile, error)
	RecordFileAccess(ctx context.Context, jobID, fileID, staffName string, download bool) (domain.Job, error)
	MarkCopiesDeleted(ctx context.Context, shopID, jobID, staffName string) (domain.Job, error)
	// Dashboard summarises the shop's last `days` days (1, 7 or 30) for the owner.
	Dashboard(ctx context.Context, shopID string, days int) (Dashboard, error)

	// Retention (background worker)
	ClaimDueFiles(ctx context.Context, limit int) ([]DueFile, error)
	MarkFileDeleted(ctx context.Context, f DueFile) (shopID string, jobDone bool, err error)
	MarkFileDeleteFailed(ctx context.Context, f DueFile, cause error) (attempts int, err error)
	AbandonDrafts(ctx context.Context) ([]domain.Job, error)
	ExpireUncollected(ctx context.Context) ([]domain.Job, error)
	DeletionHealth(ctx context.Context) (DeletionHealth, error)
}
