// Package tasks runs background workers inside the API process.
package tasks

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/realtime"
	"counter-drop/api/internal/storage"
	"counter-drop/api/internal/store"
)

type Deleter struct {
	Store    store.Repository
	Objects  storage.ObjectStore
	Hub      realtime.Publisher // optional: on AWS, live updates come from the DynamoDB stream instead
	Logger   *slog.Logger
	Interval time.Duration
}

func (d *Deleter) publish(topic string, ev realtime.Event) {
	if d.Hub != nil {
		d.Hub.Publish(topic, ev)
	}
}

// Run deletes due files every Interval and cancels abandoned drafts, until ctx ends.
func (d *Deleter) Run(ctx context.Context) {
	if d.Interval <= 0 {
		d.Interval = 30 * time.Second
	}
	t := time.NewTicker(d.Interval)
	defer t.Stop()
	for {
		_ = d.RunOnce(ctx) // failures are logged inside
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// RunOnce performs one pass (the Lambda sweeper calls it once per minute). It keeps going past
// individual failures and returns the first one, so the run shows up as failed in metrics.
func (d *Deleter) RunOnce(ctx context.Context) error {
	var first error
	note := func(err error) {
		if first == nil {
			first = err
		}
	}
	if jobs, err := d.Store.AbandonDrafts(ctx); err != nil {
		note(err)
		d.Logger.Error("abandon drafts", "error", err)
	} else {
		for _, j := range jobs {
			d.Logger.Info("draft abandoned", "job_id", j.ID)
		}
	}

	if jobs, err := d.Store.ExpireUncollected(ctx); err != nil {
		note(err)
		d.Logger.Error("expire uncollected jobs", "error", err)
	} else {
		for _, j := range jobs {
			d.Logger.Info("job closed as not collected", "job_id", j.ID, "shop_id", j.ShopID)
			d.publish(realtime.JobTopic(j.ID), realtime.Event{Type: "job.updated", Data: map[string]any{"state": j.State, "id": j.ID}})
			d.publish(realtime.ShopTopic(j.ShopID), realtime.Event{Type: "queue.changed", Data: map[string]string{"jobId": j.ID}})
		}
	}

	files, err := d.Store.ClaimDueFiles(ctx, 200)
	if err != nil {
		d.Logger.Error("list due files", "error", err)
		note(err)
		return first
	}
	for _, f := range files {
		if f.Key != "" {
			err := d.Objects.Delete(ctx, f.Key)
			if err == nil {
				// Don't trust the delete call alone: the object must really be gone.
				if _, herr := d.Objects.Head(ctx, f.Key); herr == nil {
					err = errors.New("object still present after delete")
				} else if !errors.Is(herr, storage.ErrObjectNotFound) {
					err = fmt.Errorf("verify delete: %w", herr)
				}
			}
			if err != nil {
				note(err)
				attempts, _ := d.Store.MarkFileDeleteFailed(ctx, f, err)
				level := slog.LevelWarn
				if attempts >= 3 {
					level = slog.LevelError
				}
				d.Logger.Log(ctx, level, "file delete failed", "file_id", f.ID, "job_id", f.JobID, "attempts", attempts, "error", err)
				continue
			}
		}
		shopID, done, err := d.Store.MarkFileDeleted(ctx, f)
		if err != nil {
			note(err)
			d.Logger.Error("mark file deleted", "file_id", f.ID, "error", err)
			continue
		}
		if done && f.OrderID != "" {
			d.Logger.Info("order files deleted", "order_id", f.OrderID, "shop_id", shopID)
			d.publish(realtime.OrderTopic(f.OrderID), realtime.Event{Type: "order.updated", Data: map[string]string{"id": f.OrderID}})
			d.publish(realtime.ShopTopic(shopID), realtime.Event{Type: "orders.changed", Data: map[string]string{"orderId": f.OrderID}})
			continue
		}
		if done {
			d.Logger.Info("job files deleted", "job_id", f.JobID, "shop_id", shopID)
			if j, err := d.Store.GetJob(ctx, f.JobID); err == nil {
				d.publish(realtime.JobTopic(j.ID), realtime.Event{Type: "job.files_deleted", Data: j})
				if j.State != domain.JobStateUploading {
					d.publish(realtime.ShopTopic(shopID), realtime.Event{Type: "queue.changed", Data: map[string]string{"jobId": j.ID}})
				}
			}
		}
	}
	return first
}
