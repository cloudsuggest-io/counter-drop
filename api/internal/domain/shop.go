package domain

import "time"

type OnlineState string

const (
	ShopOnline  OnlineState = "online"
	ShopPaused  OnlineState = "paused"
	ShopOffline OnlineState = "offline"
)

type Lane struct {
	ID     string `json:"id"`
	Letter string `json:"letter"`
	Name   string `json:"name"`
	Rule   string `json:"rule"` // bw | colour | any
}

type Shop struct {
	ID           string        `json:"id"`
	Slug         string        `json:"slug"`
	Name         string        `json:"name"`
	Address      string        `json:"address,omitempty"`
	Status       string        `json:"status"` // live | suspended
	OnlineState  OnlineState   `json:"onlineState"`
	PauseMessage string        `json:"pauseMessage,omitempty"`
	Timezone     string        `json:"timezone"`
	OpensAt      string        `json:"opensAt"`  // "09:00" local
	ClosesAt     string        `json:"closesAt"` // "21:30" local
	Prices       PriceList     `json:"prices"`
	Lanes        []Lane        `json:"lanes"`
	HoldDays     int           `json:"holdDays"` // uncollected jobs close after this many days (1–7)
	Orders       OrderSettings `json:"orders"`   // blackbook price list and defaults
}

// Location returns the shop's time zone, falling back to IST.
func (s Shop) Location() *time.Location {
	if loc, err := time.LoadLocation(s.Timezone); err == nil && s.Timezone != "" {
		return loc
	}
	return IST
}

// IsOpen reports whether now falls within today's opening hours.
func (s Shop) IsOpen(now time.Time) bool {
	local := now.In(s.Location())
	open, err1 := time.Parse("15:04", s.OpensAt)
	close, err2 := time.Parse("15:04", s.ClosesAt)
	if err1 != nil || err2 != nil {
		return true
	}
	mins := local.Hour()*60 + local.Minute()
	return mins >= open.Hour()*60+open.Minute() && mins < close.Hour()*60+close.Minute()
}

// ClosingTime returns today's closing time in UTC.
func (s Shop) ClosingTime(now time.Time) time.Time {
	loc := s.Location()
	local := now.In(loc)
	c, err := time.Parse("15:04", s.ClosesAt)
	if err != nil {
		return now.Add(24 * time.Hour)
	}
	return time.Date(local.Year(), local.Month(), local.Day(), c.Hour(), c.Minute(), 0, 0, loc).UTC()
}

// LaneFor picks the lane for a job: colour jobs go to a colour lane if one exists, else the first lane.
func (s Shop) LaneFor(anyColour bool) (Lane, bool) {
	if len(s.Lanes) == 0 {
		return Lane{}, false
	}
	want := "bw"
	if anyColour {
		want = "colour"
	}
	for _, l := range s.Lanes {
		if l.Rule == want {
			return l, true
		}
	}
	for _, l := range s.Lanes {
		if l.Rule == "any" {
			return l, true
		}
	}
	return s.Lanes[0], true
}
