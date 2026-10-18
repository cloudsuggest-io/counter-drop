package ddbstore

import (
	"context"
	"sync"

	"counter-drop/api/internal/store"
)

// Dashboard reads the jobs sent on each business day the dashboard covers (one GSI2 partition
// per day, a few at a time) plus the open jobs, and aggregates them.
func (s *Store) Dashboard(ctx context.Context, shopID string, days int) (store.Dashboard, error) {
	sh, err := s.GetShopByID(ctx, shopID)
	if err != nil {
		return store.Dashboard{}, err
	}
	now := s.now()
	dayList := store.DashboardDays(sh, now, days)

	perDay := make([][]jobRec, len(dayList))
	payDay := make([][]store.OrderPaymentRow, len(dayList))
	errs := make([]error, len(dayList))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, d := range dayList {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if perDay[i], errs[i] = s.dayJobs(ctx, shopID, d); errs[i] == nil {
				payDay[i], errs[i] = s.orderPayments(ctx, shopID, d)
			}
		}()
	}
	open, openErr := s.openJobs(ctx, shopID)
	copies, copiesErr := s.copiesToDelete(ctx, shopID, now)
	orders, ordErr := s.openOrders(ctx, shopID)
	wg.Wait()
	for _, e := range append(errs, openErr, copiesErr, ordErr) {
		if e != nil {
			return store.Dashboard{}, e
		}
	}

	in := store.DashboardInput{Shop: sh, Now: now, Days: days, CopiesToConfirm: len(copies)}
	for _, p := range payDay {
		in.Payments = append(in.Payments, p...)
	}
	for i := range orders {
		in.OpenOrders = append(in.OpenOrders, orders[i].domainOrder())
	}
	for _, list := range perDay {
		for i := range list {
			in.Jobs = append(in.Jobs, list[i].domainJob())
		}
	}
	for i := range open {
		in.Open = append(in.Open, open[i].domainJob())
	}
	return store.BuildDashboard(in), nil
}
