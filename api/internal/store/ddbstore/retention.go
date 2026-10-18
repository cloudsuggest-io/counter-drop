package ddbstore

import (
	"context"
	"errors"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// dueJobs returns jobs with a file whose deletion (or retry) is due at or before t.
// "$" sorts right after "#", so the bound includes keys stamped exactly at t.
func (s *Store) dueJobs(ctx context.Context, t time.Time) ([]jobRec, error) {
	var out []jobRec
	o := queryOpts{index: "GSI4", pk: "DUE"}
	if !t.IsZero() {
		o.skOp, o.sk = "<", ts(t)+"$"
	}
	err := s.query(ctx, o, decodeJobs(&out))
	return out, err
}

func dueNow(f fileRec, now time.Time) bool {
	return f.F.DeletedAt == nil && f.F.DeleteAfter != nil && !f.F.DeleteAfter.After(now) &&
		(f.NextAttemptAt == nil || !f.NextAttemptAt.After(now))
}

// ClaimDueFiles returns up to limit files whose deletion time has passed (FSD §12 worker step 1).
func (s *Store) ClaimDueFiles(ctx context.Context, limit int) ([]store.DueFile, error) {
	now := s.now()
	jobs, err := s.dueJobs(ctx, now)
	if err != nil {
		return nil, err
	}
	var out []store.DueFile
	for _, r := range jobs {
		for _, f := range r.Files {
			if len(out) == limit {
				return out, nil
			}
			if dueNow(f, now) {
				out = append(out, store.DueFile{ID: f.F.ID, JobID: r.Job.ID, Key: f.F.ObjectKey})
			}
		}
	}
	orders, err := s.dueOrders(ctx, now)
	if err != nil {
		return out, err
	}
	for _, r := range orders {
		for _, f := range r.Files {
			if len(out) == limit {
				return out, nil
			}
			if dueNow(f, now) {
				out = append(out, store.DueFile{ID: f.F.ID, OrderID: r.Order.ID, Key: f.F.ObjectKey})
			}
		}
	}
	return out, nil
}

// MarkFileDeleted records a successful delete and drops the file name. When every file of the job
// is gone, the customer's name is cleared too (BR-D4).
func (s *Store) MarkFileDeleted(ctx context.Context, due store.DueFile) (string, bool, error) {
	if due.OrderID != "" {
		return s.markOrderFileDeleted(ctx, due)
	}
	done := false
	r, err := s.mutateJob(ctx, due.JobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		f := r.file(due.ID)
		if f == nil {
			return nil, store.ErrNotFound
		}
		f.F.DeleteStatus, f.F.DeletedAt, f.F.ObjectKey, f.F.Filename, f.LastDeleteError = domain.DeleteStatusDeleted, &now, "", "", ""
		f.F.Settings.Note = "" // the note can describe the document; it goes with the file
		remaining := 0
		for _, x := range r.Files {
			if x.F.DeletedAt == nil {
				remaining++
			}
		}
		done = remaining == 0
		if done {
			r.Job.CustomerName, r.Job.UpdatedAt = "", now
			if r.Job.FilesDeletedAt == nil {
				r.Job.FilesDeletedAt = &now
			}
		}
		return nil, nil
	})
	if err != nil {
		return "", false, err
	}
	s.countDeleted(ctx)
	return r.Job.ShopID, done, nil
}

// countDeleted adds one to this hour's deletion counter (for deletion health; best effort).
func (s *Store) countDeleted(ctx context.Context) {
	now := s.now()
	_, _ = s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.table, Key: key("STATS#DEL", now.UTC().Format("2006-01-02T15")),
		UpdateExpression:          aws.String("ADD #d :one SET #t = :ttl"),
		ExpressionAttributeNames:  map[string]string{"#d": "Deleted", "#t": "ttl"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":one": nv(1), ":ttl": nv(ttlAfter(now, 72*time.Hour))},
	})
}

// MarkFileDeleteFailed schedules a retry with backoff (1, 5, 15 minutes).
func (s *Store) MarkFileDeleteFailed(ctx context.Context, due store.DueFile, cause error) (int, error) {
	if due.OrderID != "" {
		return s.markOrderFileFailed(ctx, due, cause)
	}
	attempts := 0
	_, err := s.mutateJob(ctx, due.JobID, func(r *jobRec, now time.Time) (*jobEvent, error) {
		f := r.file(due.ID)
		if f == nil {
			return nil, store.ErrNotFound
		}
		msg := cause.Error()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		f.DeleteAttempts++
		attempts = f.DeleteAttempts
		next := now.Add(store.DeleteBackoff(attempts))
		f.F.DeleteStatus, f.LastDeleteError, f.NextAttemptAt = domain.DeleteStatusFailed, msg, &next
		return nil, nil
	})
	return attempts, err
}

// AbandonDrafts cancels walk-in drafts with no activity for the abandon window.
func (s *Store) AbandonDrafts(ctx context.Context) ([]domain.Job, error) {
	cutoff := s.now().Add(-s.policy.AbandonAfter)
	var drafts []jobRec
	if err := s.query(ctx, queryOpts{index: "GSI3", pk: "DRAFT", skOp: "<", sk: ts(cutoff), limit: 200}, decodeJobs(&drafts)); err != nil {
		return nil, err
	}
	return s.closeAll(ctx, drafts, store.ActInput{Action: domain.ActionAbandon, Actor: domain.Actor{Type: domain.ActorSystem, Name: "system"}})
}

// ExpireUncollected closes jobs that stayed in line, printing or ready longer than the shop's hold days.
func (s *Store) ExpireUncollected(ctx context.Context) ([]domain.Job, error) {
	now := s.now()
	ids, err := s.allShopIDs(ctx)
	if err != nil {
		return nil, err
	}
	var out []domain.Job
	for _, id := range ids {
		sh, err := s.GetShopByID(ctx, id)
		if err != nil {
			return out, err
		}
		cutoff := now.Add(-time.Duration(sh.HoldDays) * 24 * time.Hour)
		var stale []jobRec
		if err := s.query(ctx, queryOpts{index: "GSI1", pk: "S#" + id + "#OPEN", skOp: "<", sk: ts(cutoff), limit: 200}, decodeJobs(&stale)); err != nil {
			return out, err
		}
		closed, err := s.closeAll(ctx, stale, store.ActInput{Action: domain.ActionCancel, Actor: domain.Actor{Type: domain.ActorSystem, Name: "system"}, Reason: "not_collected"})
		out = append(out, closed...)
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

func (s *Store) closeAll(ctx context.Context, list []jobRec, in store.ActInput) ([]domain.Job, error) {
	var out []domain.Job
	for _, r := range list {
		j, err := s.Act(ctx, r.Job.ID, in)
		if errors.Is(err, domain.ErrInvalidTransition) {
			continue // someone else moved it on meanwhile
		}
		if err != nil {
			return out, err
		}
		out = append(out, j)
	}
	return out, nil
}

func (s *Store) DeletionHealth(ctx context.Context) (store.DeletionHealth, error) {
	now := s.now()
	var h store.DeletionHealth
	jobs, err := s.dueJobs(ctx, time.Time{})
	if err != nil {
		return h, err
	}
	for _, r := range jobs {
		for _, f := range r.Files {
			if f.F.DeletedAt != nil {
				continue
			}
			if f.F.DeleteAfter != nil && !f.F.DeleteAfter.After(now) {
				h.DueNow++
			}
			if f.F.DeleteStatus == domain.DeleteStatusFailed {
				h.Failed++
			}
			if h.OldestUndeleted == nil || f.CreatedAt.Before(*h.OldestUndeleted) {
				t := f.CreatedAt
				h.OldestUndeleted = &t
			}
		}
	}
	orders, err := s.dueOrders(ctx, time.Time{})
	if err != nil {
		return h, err
	}
	for _, r := range orders {
		for _, f := range r.Files {
			if f.F.DeletedAt != nil {
				continue
			}
			if f.F.DeleteAfter != nil && !f.F.DeleteAfter.After(now) {
				h.DueNow++
			}
			if f.F.DeleteStatus == domain.DeleteStatusFailed {
				h.Failed++
			}
		}
	}
	since := now.Add(-24 * time.Hour).UTC().Format("2006-01-02T15")
	err = s.query(ctx, queryOpts{pk: "STATS#DEL", skOp: ">=", sk: since}, func(item map[string]types.AttributeValue) (bool, error) {
		var st statRec
		if err := attributevalue.UnmarshalMap(item, &st); err != nil {
			return false, err
		}
		h.Deleted24h += st.Deleted
		return true, nil
	})
	return h, err
}
