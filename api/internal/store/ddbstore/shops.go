package ddbstore

import (
	"context"
	"errors"
	"strings"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func (s *Store) GetShopByID(ctx context.Context, id string) (domain.Shop, error) {
	var r shopRec
	if err := s.get(ctx, "S#"+id, "PROFILE", &r); err != nil {
		return domain.Shop{}, err
	}
	return r.shop(), nil
}

func (r shopRec) shop() domain.Shop {
	sh := r.Shop
	if sh.Lanes == nil {
		sh.Lanes = []domain.Lane{}
	}
	sh.Orders = sh.Orders.Normalise()
	return sh
}

func (s *Store) GetShopBySlug(ctx context.Context, slug string) (domain.Shop, error) {
	var g slugRec
	if err := s.get(ctx, "SLUG#"+strings.ToLower(strings.TrimSpace(slug)), "SLUG", &g); err != nil {
		return domain.Shop{}, err
	}
	return s.GetShopByID(ctx, g.ShopID)
}

// CreateShop adds a live shop with the default lanes and prices, and its owner, in one transaction.
// The slug guard item makes link names unique.
func (s *Store) CreateShop(ctx context.Context, in store.CreateShopInput) (domain.Shop, error) {
	in, err := store.ValidateNewShop(in)
	if err != nil {
		return domain.Shop{}, err
	}
	now := s.now()
	sh := domain.Shop{
		ID: store.NewID("shop"), Slug: in.Slug, Name: in.Name, Address: in.Address, Status: "live",
		OnlineState: domain.ShopOnline, Timezone: "Asia/Kolkata", OpensAt: "09:00", ClosesAt: "21:30",
		Prices: domain.DefaultPriceList(), Lanes: store.DefaultLanes(), HoldDays: 7,
	}
	owner, err := s.newStaff(sh.ID, in.OwnerName, "owner", in.OwnerPIN)
	if err != nil {
		return domain.Shop{}, err
	}
	rec := newShopRec(sh, now)
	rec.OwnerCount = 1
	items := []types.TransactWriteItem{
		s.put(slugRec{PK: "SLUG#" + sh.Slug, SK: "SLUG", Type: "slug", ShopID: sh.ID}, "attribute_not_exists(PK)", nil, nil),
		s.put(rec, "attribute_not_exists(PK)", nil, nil),
	}
	items = append(items, s.staffPuts(owner)...)
	if i, err := s.transact(ctx, items...); err != nil {
		if errors.Is(err, errConflict) && i == 0 {
			return domain.Shop{}, store.ErrSlugTaken
		}
		return domain.Shop{}, err
	}
	return sh, nil
}

// SeedDemo creates the demo shop "demo-print" with staff Owner (PIN 1234) and Kavita (PIN 1111) if missing.
func (s *Store) SeedDemo(ctx context.Context) error {
	sh, err := s.GetShopBySlug(ctx, "demo-print")
	if err == nil {
		list, err := s.allStaff(ctx, sh.ID)
		if err != nil || len(list) > 0 {
			return err
		}
		if err := s.AddStaff(ctx, sh.ID, "Owner", "owner", "1234"); err != nil {
			return err
		}
		return s.AddStaff(ctx, sh.ID, "Kavita", "staff", "1111")
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	sh, err = s.CreateShop(ctx, store.CreateShopInput{Slug: "demo-print", Name: "Demo Print Counter", Address: "Dadar West, Mumbai", OwnerName: "Owner", OwnerPIN: "1234"})
	if err != nil {
		return err
	}
	return s.AddStaff(ctx, sh.ID, "Kavita", "staff", "1111")
}

// mutateShop is a read-modify-write of the shop item, retried if another writer got there first.
func (s *Store) mutateShop(ctx context.Context, shopID string, fn func(r *shopRec) error) (domain.Shop, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		var r shopRec
		if err := s.get(ctx, "S#"+shopID, "PROFILE", &r); err != nil {
			return domain.Shop{}, err
		}
		old := r.Ver
		if err := fn(&r); err != nil {
			return domain.Shop{}, err
		}
		r.Ver++
		_, err := s.transact(ctx, s.put(r, "#v = :v", map[string]string{"#v": "Ver"}, map[string]types.AttributeValue{":v": nv(old)}))
		if errors.Is(err, errConflict) {
			continue
		}
		if err != nil {
			return domain.Shop{}, err
		}
		return r.shop(), nil
	}
	return domain.Shop{}, errBusy
}

func (s *Store) SetShopState(ctx context.Context, shopID string, state domain.OnlineState, msg string) (domain.Shop, error) {
	msg, err := store.ValidateShopState(state, msg)
	if err != nil {
		return domain.Shop{}, err
	}
	return s.mutateShop(ctx, shopID, func(r *shopRec) error {
		r.Shop.OnlineState, r.Shop.PauseMessage = state, msg
		return nil
	})
}

func (s *Store) UpdateShopSettings(ctx context.Context, shopID string, p store.ShopProfile, prices domain.PriceList) (domain.Shop, error) {
	return s.mutateShop(ctx, shopID, func(r *shopRec) error {
		prof, pl, err := store.ValidateSettings(r.shop(), p, prices)
		if err != nil {
			return err
		}
		r.Shop.Name, r.Shop.Address, r.Shop.OpensAt, r.Shop.ClosesAt, r.Shop.HoldDays = prof.Name, prof.Address, prof.OpensAt, prof.ClosesAt, prof.HoldDays
		r.Shop.Prices = pl
		return nil
	})
}

// allShopIDs lists every shop (the sweeper walks shops to close stale jobs).
func (s *Store) allShopIDs(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.query(ctx, queryOpts{index: "GSI3", pk: "SHOPS"}, func(item map[string]types.AttributeValue) (bool, error) {
		if v, ok := item["GSI3SK"].(*types.AttributeValueMemberS); ok {
			ids = append(ids, v.Value)
		}
		return true, nil
	})
	return ids, err
}
