package ddbstore

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// --- read-modify-write of one job ----------------------------------------------------------------

// jobEvent is the audit entry written with a change.
type jobEvent struct {
	from   domain.JobState
	action domain.Action
	actor  domain.Actor
	reason string
}

// errNoWrite lets a mutation finish without writing (the change was already made).
var errNoWrite = errors.New("no write")

func (s *Store) loadJob(ctx context.Context, id string) (*jobRec, error) {
	var r jobRec
	if err := s.get(ctx, jobPK(id), "JOB", &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// mutateJob reads the job, applies fn and writes it back only if nobody changed it in between
// (version check); on a clash it starts again from a fresh read.
func (s *Store) mutateJob(ctx context.Context, id string, fn func(r *jobRec, now time.Time) (*jobEvent, error)) (*jobRec, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		r, err := s.loadJob(ctx, id)
		if err != nil {
			return nil, err
		}
		old := r.Ver
		now := s.now()
		ev, err := fn(r, now)
		if errors.Is(err, errNoWrite) {
			return r, nil
		}
		if err != nil {
			return nil, err
		}
		r.Ver++
		r.reindex()
		items := []types.TransactWriteItem{s.put(r, "#v = :v", map[string]string{"#v": "Ver"}, map[string]types.AttributeValue{":v": nv(old)})}
		if ev != nil {
			items = append(items, s.put(s.eventRec(r.Job, *ev, now), "", nil, nil))
		}
		_, err = s.transact(ctx, items...)
		if errors.Is(err, errConflict) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return r, nil
	}
	return nil, errBusy
}

func (s *Store) eventRec(j domain.Job, ev jobEvent, now time.Time) eventRec {
	return eventRec{
		PK: jobPK(j.ID), SK: "EVT#" + ts(now) + "#" + store.NewSecret()[:8], Type: "event",
		JobID: j.ID, ShopID: j.ShopID, FromState: string(ev.from), ToState: string(j.State), Action: string(ev.action),
		ActorType: string(ev.actor.Type), ActorName: ev.actor.Name, Reason: ev.reason, At: now,
		TTL: ttlAfter(now, eventRetention),
	}
}

func (s *Store) GetJob(ctx context.Context, id string) (domain.Job, error) {
	r, err := s.loadJob(ctx, id)
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

func (s *Store) VerifySecret(ctx context.Context, jobID, secret string) error {
	r, err := s.loadJob(ctx, jobID)
	if err != nil {
		return err
	}
	if !store.EqualHash(secret, r.SecretHash) {
		return store.ErrBadSecret
	}
	return nil
}

// --- create / upload / edit ----------------------------------------------------------------------

func (s *Store) CreateJob(ctx context.Context, sh domain.Shop, in store.CreateJobInput, lim store.Limits) (domain.Job, string, error) {
	now := s.now()
	if err := store.ShopAccepting(sh, now); err != nil {
		return domain.Job{}, "", err
	}
	name, err := store.ValidName(in.CustomerName)
	if err != nil {
		return domain.Job{}, "", err
	}
	if err := store.ValidateFiles(in.Files, lim, 0, 0); err != nil {
		return domain.Job{}, "", err
	}
	secret := store.NewSecret()
	j := domain.Job{
		ID: store.NewID("job"), ShopID: sh.ID, Channel: domain.ChannelWalkIn, CustomerName: name,
		State: domain.JobStateUploading, CreatedAt: now, UpdatedAt: now, BusinessDay: domain.BusinessDay(now, sh.Location()),
	}
	r := &jobRec{PK: jobPK(j.ID), SK: "JOB", Type: "job", Ver: 1, SecretHash: store.HashSecret(secret), Job: j}
	if err := r.addFiles(in.Files, now); err != nil {
		return domain.Job{}, "", err
	}
	r.reindex()
	if _, err := s.transact(ctx, s.put(r, "attribute_not_exists(PK)", nil, nil)); err != nil {
		return domain.Job{}, "", err
	}
	return r.domainJob(), secret, nil
}

func (r *jobRec) addFiles(files []store.NewFile, now time.Time) error {
	seq := 0
	for _, f := range r.Files {
		if f.Seq >= seq {
			seq = f.Seq + 1
		}
	}
	for i, in := range files {
		f, err := store.NewJobFile(r.Job.ShopID, r.Job.ID, in)
		if err != nil {
			return err
		}
		r.Files = append(r.Files, fileRec{F: f, Seq: seq + i, CreatedAt: now})
	}
	return nil
}

// liveFiles are files still part of the draft (not removed, not scheduled for deletion).
func (r *jobRec) liveFiles() (size int64, count int) {
	for _, f := range r.Files {
		if f.F.DeleteStatus == domain.DeleteStatusActive && f.RemovedAt == nil {
			size += f.F.Size
			count++
		}
	}
	return
}

func (s *Store) AddFiles(ctx context.Context, jobID string, files []store.NewFile, lim store.Limits) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if r.Job.State != domain.JobStateUploading {
			return nil, store.ErrNotEditable
		}
		size, count := r.liveFiles()
		if err := store.ValidateFiles(files, lim, size, count); err != nil {
			return nil, err
		}
		return nil, r.addFiles(files, now)
	})
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

func (s *Store) FileUploaded(ctx context.Context, jobID, fileID string, pages int) (domain.JobFile, error) {
	var out domain.JobFile
	_, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if r.Job.State != domain.JobStateUploading {
			return nil, store.ErrNotEditable
		}
		f := r.file(fileID)
		if f == nil || f.F.DeleteStatus != domain.DeleteStatusActive || f.RemovedAt != nil {
			return nil, store.ErrNotFound
		}
		sh, err := s.GetShopByID(ctx, r.Job.ShopID)
		if err != nil {
			return nil, err
		}
		p, status := store.UploadedPages(f.F.Mime, pages)
		expiry := store.DraftFileExpiry(sh, now)
		f.F.UploadStatus, f.F.Pages, f.F.PagesStatus, f.F.DeleteAfter = domain.UploadStatusUploaded, p, status, &expiry
		out = f.F
		return nil, nil
	})
	return out, err
}

func (s *Store) RemoveFile(ctx context.Context, jobID, fileID string) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if r.Job.State != domain.JobStateUploading {
			return nil, store.ErrNotEditable
		}
		f := r.file(fileID)
		if f == nil || f.F.DeleteStatus != domain.DeleteStatusActive || f.RemovedAt != nil {
			return nil, store.ErrNotFound
		}
		// Removed files vanish from the job at once and are erased on the next worker run.
		f.F.DeleteStatus, f.F.DeleteAfter, f.RemovedAt = domain.DeleteStatusPending, &now, &now
		return nil, nil
	})
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

func (s *Store) UpdateJob(ctx context.Context, jobID string, name *string, files []store.FileSettingsUpdate) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if !store.CanEdit(r.Job) {
			return nil, store.ErrNotEditable
		}
		sh, err := s.GetShopByID(ctx, r.Job.ShopID)
		if err != nil {
			return nil, err
		}
		if name != nil {
			n, err := store.ValidName(*name)
			if err != nil {
				return nil, err
			}
			r.Job.CustomerName, r.Job.UpdatedAt = n, now
		}
		for _, u := range files {
			f := r.file(u.FileID)
			if f == nil || f.F.DeleteStatus != domain.DeleteStatusActive || f.RemovedAt != nil {
				return nil, store.ErrNotFound
			}
			st, err := store.EditableSettings(sh, f.F, u.Settings)
			if err != nil {
				return nil, err
			}
			f.F.Settings = st
		}
		if r.Job.State == domain.JobStateQueued {
			q, err := store.QuoteFor(sh, r.domainJob())
			if err != nil {
				return nil, err
			}
			r.Job.PriceTotal, r.Job.PagesTotal, r.Job.PagesToConfirm, r.Job.UpdatedAt = q.TotalPaise, q.PagesTotal, q.PagesToConfirm, now
		}
		return nil, nil
	})
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

// --- submit and transitions ------------------------------------------------------------------------

// nextToken takes the next number in a lane's daily sequence. A submit that fails after this step
// leaves a gap in the numbers (accepted in ADR-001).
func (s *Store) nextToken(ctx context.Context, shopID, lane, day string, now time.Time) (int, error) {
	res, err := s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.table, Key: key("S#"+shopID, "TOK#"+day+"#"+lane),
		UpdateExpression:          aws.String("ADD #n :one SET #t = :ttl"),
		ExpressionAttributeNames:  map[string]string{"#n": "LastNo", "#t": "ttl"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":one": nv(1), ":ttl": nv(ttlAfter(now, 72*time.Hour))},
		ReturnValues:              types.ReturnValueUpdatedNew,
	})
	if err != nil {
		return 0, err
	}
	var c counterRec
	if err := attributevalue.UnmarshalMap(res.Attributes, &c); err != nil {
		return 0, err
	}
	return c.LastNo, nil
}

func (s *Store) Submit(ctx context.Context, jobID, priceVersion, name string) (domain.Job, domain.Quote, error) {
	var quote domain.Quote
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		sh, err := s.GetShopByID(ctx, r.Job.ShopID)
		if err != nil {
			return nil, err
		}
		if err := store.ShopAccepting(sh, now); err != nil {
			return nil, err
		}
		j := r.domainJob()
		var anyColour bool
		quote, anyColour, err = store.SubmitCheck(sh, j, priceVersion)
		if err != nil {
			return nil, err
		}
		fx, err := domain.Transition(&j, domain.ActionSubmit, domain.Actor{Type: domain.ActorGuest}, "", now, s.policy)
		if err != nil {
			return nil, err
		}
		if fx.IssueToken {
			lane, ok := sh.LaneFor(anyColour)
			if !ok {
				return nil, fmt.Errorf("shop has no lanes")
			}
			day := domain.BusinessDay(now, sh.Location())
			n, err := s.nextToken(ctx, sh.ID, lane.Letter, day, now)
			if err != nil {
				return nil, err
			}
			j.LaneID, j.Lane, j.Token, j.BusinessDay = lane.ID, lane.Letter, domain.FormatToken(lane.Letter, n), day
		}
		wait, err := s.waitFor(ctx, sh.ID, now)
		if err != nil {
			return nil, err
		}
		if name != "" {
			if n, err := store.ValidName(name); err == nil {
				j.CustomerName = n
			}
		}
		r.Job.State, r.Job.QueuedAt, r.Job.UpdatedAt = j.State, j.QueuedAt, now
		r.Job.LaneID, r.Job.Lane, r.Job.Token, r.Job.BusinessDay = j.LaneID, j.Lane, j.Token, j.BusinessDay
		r.Job.PriceTotal, r.Job.PagesTotal, r.Job.PagesToConfirm = quote.TotalPaise, quote.PagesTotal, quote.PagesToConfirm
		readyBy := store.ReadyBy(now, wait, quote.PagesTotal)
		r.Job.ReadyBy, r.Job.CustomerName = &readyBy, j.CustomerName
		// While the job is in line, printing or ready its files are kept; they are scheduled for
		// deletion when it is collected, cancelled or closed as not collected.
		for i := range r.Files {
			if r.Files[i].F.DeleteStatus == domain.DeleteStatusActive {
				r.Files[i].F.DeleteAfter = nil
			}
		}
		return &jobEvent{from: domain.JobStateUploading, action: domain.ActionSubmit, actor: domain.Actor{Type: domain.ActorGuest}}, nil
	})
	if err != nil {
		return domain.Job{}, domain.Quote{}, err
	}
	return r.domainJob(), quote, nil
}

// confirmPages records the page counts staff entered for files the phone couldn't count and
// reprices the job with the shop's current price list.
func (s *Store) confirmPages(ctx context.Context, r *jobRec, pages map[string]int) error {
	for id, n := range pages {
		f := r.file(id)
		if f == nil || f.RemovedAt != nil {
			return store.ErrNotFound
		}
		if f.F.Settings.Other || domain.FileKind(f.F.Mime) == "image" || f.F.PagesStatus == domain.PagesCounted {
			continue // counted on the phone (or not printed): nothing to confirm
		}
		if n < 1 || n > domain.MaxConfirmedPages {
			return fmt.Errorf("%w: pages must be 1 to %d", domain.ErrValidation, domain.MaxConfirmedPages)
		}
		f.F.Pages, f.F.PagesStatus = n, domain.PagesConfirmed
	}
	sh, err := s.GetShopByID(ctx, r.Job.ShopID)
	if err != nil {
		return err
	}
	q, err := store.QuoteFor(sh, r.domainJob())
	if err != nil {
		return err
	}
	other := int64(0)
	if r.Job.OtherPrice != nil {
		other = *r.Job.OtherPrice
	}
	r.Job.PriceTotal, r.Job.PagesTotal, r.Job.PagesToConfirm = q.TotalPaise+other, q.PagesTotal, q.PagesToConfirm
	return nil
}

// apply runs a state transition on the record and carries out its effects on the files.
func (s *Store) apply(r *jobRec, in store.ActInput, now time.Time) (*jobEvent, error) {
	from := r.Job.State
	j := r.domainJob()
	fx, err := domain.Transition(&j, in.Action, in.Actor, strings.TrimSpace(in.Reason), now, s.policy)
	if err != nil {
		return nil, err
	}
	if in.Action == domain.ActionReady && j.HasOther() {
		if in.OtherPrice == nil {
			return nil, domain.ErrPriceRequired
		}
		if err := j.SetOtherPrice(*in.OtherPrice); err != nil {
			return nil, err
		}
	}
	files := r.Files
	r.Job = j
	r.Job.Files = nil
	r.Files = files
	if in.Action == domain.ActionCollected && (in.Paid == "cash" || in.Paid == "upi") {
		r.Job.PaidMethod = in.Paid
	}
	if in.Action == domain.ActionCollected {
		r.Job.NoReceipt = in.NoReceipt
	}
	if fx.ScheduleDelete != nil {
		for i := range r.Files {
			f := &r.Files[i]
			if f.F.DeletedAt != nil {
				continue
			}
			f.F.DeleteStatus = domain.DeleteStatusPending
			if f.F.DeleteAfter == nil || f.F.DeleteAfter.After(*fx.ScheduleDelete) {
				at := *fx.ScheduleDelete
				f.F.DeleteAfter = &at
			}
		}
	}
	if fx.ClearDelete {
		for i := range r.Files {
			f := &r.Files[i]
			if f.F.DeletedAt == nil && f.RemovedAt == nil {
				f.F.DeleteStatus, f.F.DeleteAfter = domain.DeleteStatusActive, nil
			}
		}
	}
	return &jobEvent{from: from, action: in.Action, actor: in.Actor, reason: in.Reason}, nil
}

func (s *Store) Act(ctx context.Context, jobID string, in store.ActInput) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if in.Actor.Type == domain.ActorStaff && (r.Job.ShopID != in.ShopID || r.Job.State == domain.JobStateUploading) {
			return nil, store.ErrNotFound
		}
		if in.Action == domain.ActionReady {
			if len(in.Pages) > 0 {
				if err := s.confirmPages(ctx, r, in.Pages); err != nil {
					return nil, err
				}
			}
			if r.Job.PagesToConfirm {
				return nil, domain.ErrPagesRequired
			}
		}
		return s.apply(r, in, now)
	})
	if err != nil {
		if errors.Is(err, domain.ErrInvalidTransition) && in.Action == domain.ActionClaim {
			if cur, e := s.GetJob(ctx, jobID); e == nil && cur.State == domain.JobStateClaimed {
				return cur, store.ErrAlreadyClaimed
			}
		}
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

// ClaimNext claims the oldest queued job in a lane (or across lanes when lane is ""). If another
// counter takes a candidate first, it moves on to the next one.
func (s *Store) ClaimNext(ctx context.Context, shopID, lane string, actor domain.Actor) (domain.Job, error) {
	open, err := s.openJobs(ctx, shopID)
	if err != nil {
		return domain.Job{}, err
	}
	for _, c := range open {
		if c.Job.State != domain.JobStateQueued || (lane != "" && c.Job.Lane != lane) {
			continue
		}
		j, err := s.Act(ctx, c.Job.ID, store.ActInput{Action: domain.ActionClaim, Actor: actor, ShopID: shopID})
		if errors.Is(err, store.ErrAlreadyClaimed) || errors.Is(err, domain.ErrInvalidTransition) || errors.Is(err, errBusy) {
			continue // another counter got it first
		}
		return j, err
	}
	return domain.Job{}, store.ErrLaneEmpty
}

// --- queue, lookup, wait -----------------------------------------------------------------------------

func decodeJobs(dst *[]jobRec) func(map[string]types.AttributeValue) (bool, error) {
	return func(item map[string]types.AttributeValue) (bool, error) {
		var r jobRec
		if err := attributevalue.UnmarshalMap(item, &r); err != nil {
			return false, err
		}
		*dst = append(*dst, r)
		return true, nil
	}
}

// openJobs returns queued, claimed and ready jobs in queue order.
func (s *Store) openJobs(ctx context.Context, shopID string) ([]jobRec, error) {
	var out []jobRec
	err := s.query(ctx, queryOpts{index: "GSI1", pk: "S#" + shopID + "#OPEN"}, decodeJobs(&out))
	return out, err
}

// dayJobs returns the jobs sent on the given business days (oldest first).
func (s *Store) dayJobs(ctx context.Context, shopID string, days ...string) ([]jobRec, error) {
	var out []jobRec
	for _, d := range days {
		if err := s.query(ctx, queryOpts{index: "GSI2", pk: "S#" + shopID + "#D#" + d}, decodeJobs(&out)); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func today(sh domain.Shop, now time.Time) (string, string) {
	loc := sh.Location()
	return domain.BusinessDay(now, loc), domain.BusinessDay(now.Add(-24*time.Hour), loc)
}

func (s *Store) Queue(ctx context.Context, shopID string) (store.QueueSnapshot, error) {
	sh, err := s.GetShopByID(ctx, shopID)
	if err != nil {
		return store.QueueSnapshot{}, err
	}
	now := s.now()
	open, err := s.openJobs(ctx, shopID)
	if err != nil {
		return store.QueueSnapshot{}, err
	}
	d0, d1 := today(sh, now)
	recent, err := s.dayJobs(ctx, shopID, d1, d0)
	if err != nil {
		return store.QueueSnapshot{}, err
	}
	var list []jobRec
	list = append(list, open...)
	todayCount := 0
	for _, r := range recent {
		if r.Job.BusinessDay == d0 && r.Job.State != domain.JobStateUploading {
			todayCount++
		}
		if r.Job.State == domain.JobStateCollected && r.Job.CollectedAt != nil && r.Job.CollectedAt.After(now.Add(-s.policy.UndoWindow)) {
			list = append(list, r)
		}
	}
	sortByQueue(list)
	if len(list) > 500 {
		list = list[:500]
	}
	jobs := make([]domain.Job, 0, len(list))
	for i := range list {
		jobs = append(jobs, list[i].domainJob())
	}
	wait := waitFrom(open, recent, now)
	copies, err := s.copiesToDelete(ctx, shopID, now)
	if err != nil {
		return store.QueueSnapshot{}, err
	}
	return store.QueueSnapshot{Shop: sh, Jobs: jobs, CopiesToDelete: copies, TodayCount: todayCount, Wait: wait,
		UndoWindow: int(s.policy.UndoWindow.Seconds()), ServerTime: now}, nil
}

func queueKey(r jobRec) string {
	if r.Job.QueuedAt == nil {
		return "~" + r.Job.ID
	}
	return ts(*r.Job.QueuedAt) + "#" + r.Job.ID
}

func sortByQueue(list []jobRec) {
	sort.SliceStable(list, func(a, b int) bool { return queueKey(list[a]) < queueKey(list[b]) })
}

// waitFor estimates the wait for a new job: queued + printing jobs ahead, shared by active counters.
func (s *Store) waitFor(ctx context.Context, shopID string, now time.Time) (domain.WaitEstimate, error) {
	sh, err := s.GetShopByID(ctx, shopID)
	if err != nil {
		return domain.WaitEstimate{}, err
	}
	open, err := s.openJobs(ctx, shopID)
	if err != nil {
		return domain.WaitEstimate{}, err
	}
	d0, d1 := today(sh, now)
	recent, err := s.dayJobs(ctx, shopID, d1, d0)
	if err != nil {
		return domain.WaitEstimate{}, err
	}
	return waitFrom(open, recent, now), nil
}

// waitFrom computes the estimate from jobs already loaded: open jobs give the pages ahead; open and
// recent jobs together give the counters that claimed something in the last 30 minutes.
func waitFrom(open, recent []jobRec, now time.Time) domain.WaitEstimate {
	var pages []int
	counters := map[string]bool{}
	since := now.Add(-store.ActiveCounterWindow)
	for _, r := range open {
		if r.Job.State == domain.JobStateQueued || r.Job.State == domain.JobStateClaimed {
			pages = append(pages, r.Job.PagesTotal)
		}
	}
	for _, list := range [][]jobRec{open, recent} {
		for _, r := range list {
			if r.Job.ClaimedBy != "" && r.Job.ClaimedAt != nil && r.Job.ClaimedAt.After(since) {
				counters[r.Job.ClaimedBy] = true
			}
		}
	}
	return domain.EstimateWait(pages, 3, len(counters))
}

func (s *Store) Wait(ctx context.Context, shopID string) (domain.WaitEstimate, error) {
	return s.waitFor(ctx, shopID, s.now())
}

// Position counts queued or printing jobs in the same lane that are ahead of this one.
func (s *Store) Position(ctx context.Context, j domain.Job) (int, error) {
	if j.State != domain.JobStateQueued || j.QueuedAt == nil {
		return 0, nil
	}
	open, err := s.openJobs(ctx, j.ShopID)
	if err != nil {
		return 0, err
	}
	mine := ts(*j.QueuedAt) + "#" + j.ID
	n := 0
	for _, r := range open {
		if r.Job.LaneID != j.LaneID || r.Job.ID == j.ID {
			continue
		}
		if r.Job.State == domain.JobStateClaimed || (r.Job.State == domain.JobStateQueued && queueKey(r) < mine) {
			n++
		}
	}
	return n, nil
}

// Lookup finds today's open jobs by token (A07, a-7) or first-name prefix.
func (s *Store) Lookup(ctx context.Context, shopID, q string) ([]domain.Job, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []domain.Job{}, nil
	}
	sh, err := s.GetShopByID(ctx, shopID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	token := store.LookupToken(q)
	d0, d1 := today(sh, now)
	recent, err := s.dayJobs(ctx, shopID, d1, d0)
	if err != nil {
		return nil, err
	}
	open, err := s.openJobs(ctx, shopID)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var hits []jobRec
	for _, r := range append(recent, open...) {
		j := r.Job
		if seen[j.ID] || !j.CreatedAt.After(now.Add(-24*time.Hour)) {
			continue
		}
		switch j.State {
		case domain.JobStateQueued, domain.JobStateClaimed, domain.JobStateReady, domain.JobStateCollected:
		default:
			continue
		}
		byToken := token != "" && j.Token == token
		byName := len(q) >= 2 && strings.HasPrefix(strings.ToLower(j.CustomerName), strings.ToLower(q))
		if byToken || byName {
			seen[j.ID] = true
			hits = append(hits, r)
		}
	}
	sortByQueue(hits)
	out := []domain.Job{}
	for i := len(hits) - 1; i >= 0 && len(out) < 10; i-- { // newest first
		out = append(out, hits[i].domainJob())
	}
	return out, nil
}

// --- files ----------------------------------------------------------------------------------------------

func (s *Store) FileForShop(ctx context.Context, shopID, jobID, fileID string) (domain.JobFile, error) {
	j, err := s.GetJob(ctx, jobID)
	if err != nil {
		return domain.JobFile{}, err
	}
	if j.ShopID != shopID || j.State == domain.JobStateUploading || j.State == domain.JobStateCancelled {
		return domain.JobFile{}, store.ErrNotFound
	}
	for _, f := range j.Files {
		if f.ID == fileID && f.DeletedAt == nil && f.ObjectKey != "" && f.UploadStatus == domain.UploadStatusUploaded {
			return f, nil
		}
	}
	return domain.JobFile{}, store.ErrNotFound
}

func (s *Store) FileForGuest(ctx context.Context, jobID, fileID string) (domain.Job, domain.JobFile, error) {
	j, err := s.GetJob(ctx, jobID)
	if err != nil {
		return j, domain.JobFile{}, err
	}
	for _, f := range j.Files {
		if f.ID == fileID && f.DeleteStatus == domain.DeleteStatusActive {
			return j, f, nil
		}
	}
	return j, domain.JobFile{}, store.ErrNotFound
}

// RecordFileAccess notes that staff opened a file to print it or downloaded it to their device.
func (s *Store) RecordFileAccess(ctx context.Context, jobID, fileID, staffName string, download bool) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		f := r.file(fileID)
		action := domain.Action("file_print")
		if download {
			action = "file_download"
			// A new download means there is (again) a copy the shop must delete.
			r.Job.CopiesDeletedAt, r.Job.CopiesDeletedBy = nil, ""
		}
		if f != nil {
			if download {
				f.F.Downloads++
				if f.F.DownloadedAt == nil {
					f.F.DownloadedAt = &now
				}
				if f.F.DownloadedBy == "" {
					f.F.DownloadedBy = staffName
				}
			} else {
				f.F.PrintOpens++
				if f.F.PrintedAt == nil {
					f.F.PrintedAt = &now
				}
			}
		}
		return &jobEvent{from: r.Job.State, action: action, actor: domain.Actor{Type: domain.ActorStaff, Name: staffName}, reason: fileID}, nil
	})
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

// RequestCopiesDeletion is the customer asking, after pickup, for their files to be deleted.
func (s *Store) RequestCopiesDeletion(ctx context.Context, jobID string) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if r.Job.State != domain.JobStateCollected {
			return nil, domain.ErrInvalidTransition
		}
		if r.Job.CopiesDeleteRequestedAt != nil {
			return nil, errNoWrite
		}
		r.Job.CopiesDeleteRequestedAt, r.Job.UpdatedAt = &now, now
		for i := range r.Files {
			f := &r.Files[i]
			if f.F.DeletedAt == nil && (f.F.DeleteAfter == nil || f.F.DeleteAfter.After(now)) {
				f.F.DeleteStatus, f.F.DeleteAfter = domain.DeleteStatusPending, &now
			}
		}
		if !r.downloaded() && r.Job.CopiesDeletedAt == nil {
			r.Job.CopiesDeletedAt, r.Job.CopiesDeletedBy = &now, "no-downloads"
		}
		return &jobEvent{from: r.Job.State, action: "delete_requested", actor: domain.Actor{Type: domain.ActorGuest, Name: "customer"}}, nil
	})
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

// MarkCopiesDeleted is the shop confirming it deleted the copies it downloaded.
func (s *Store) MarkCopiesDeleted(ctx context.Context, shopID, jobID, staffName string) (domain.Job, error) {
	r, err := s.mutateJob(ctx, jobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		if r.Job.ShopID != shopID || r.Job.State == domain.JobStateUploading {
			return nil, store.ErrNotFound
		}
		if !r.Job.State.IsTerminal() {
			return nil, fmt.Errorf("%w: finish the job first (collected or cancelled)", domain.ErrValidation)
		}
		if !r.downloaded() {
			return nil, fmt.Errorf("%w: nothing from this job was downloaded", domain.ErrValidation)
		}
		if r.Job.CopiesDeletedAt != nil {
			return nil, errNoWrite
		}
		r.Job.CopiesDeletedAt, r.Job.CopiesDeletedBy, r.Job.UpdatedAt = &now, staffName, now
		return &jobEvent{from: r.Job.State, action: "copies_deleted", actor: domain.Actor{Type: domain.ActorStaff, Name: staffName}}, nil
	})
	if err != nil {
		return domain.Job{}, err
	}
	return r.domainJob(), nil
}

// copiesToDelete lists finished jobs (last 30 days) whose downloaded copies the shop hasn't confirmed deleting.
func (s *Store) copiesToDelete(ctx context.Context, shopID string, now time.Time) ([]domain.Job, error) {
	var list []jobRec
	err := s.query(ctx, queryOpts{index: "GSI3", pk: "COPIES#" + shopID, skOp: ">", sk: ts(now.Add(-store.CopiesWindow))}, decodeJobs(&list))
	if err != nil {
		return nil, err
	}
	sort.SliceStable(list, func(a, b int) bool {
		ra, rb := list[a].Job.CopiesDeleteRequestedAt, list[b].Job.CopiesDeleteRequestedAt
		if (ra == nil) != (rb == nil) {
			return ra != nil // requested first
		}
		if ra != nil && !ra.Equal(*rb) {
			return ra.After(*rb)
		}
		ca, cb := list[a].Job.CollectedAt, list[b].Job.CollectedAt
		if (ca == nil) != (cb == nil) {
			return ca != nil
		}
		return ca != nil && ca.After(*cb)
	})
	out := []domain.Job{}
	for i := range list {
		if len(out) == 100 {
			break
		}
		out = append(out, list[i].domainJob())
	}
	return out, nil
}
