package realtime

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// A ticket lets a browser open a WebSocket for one topic. Browsers can't send headers on a
// WebSocket, and the job secret or session token must never appear in a URL (it would end up in
// access logs), so the API hands out a short-lived signed ticket instead:
//
//	base64url(payload) "." base64url(HMAC-SHA256(key, payload))     payload = {"t":topic,"e":unix expiry}
//
// The API signs it; the WebSocket gateway ($connect) verifies it with the same key.

// TicketTTL is how long a ticket can be used to open a connection (not how long the connection lasts).
const TicketTTL = 60 * time.Second

var ErrBadTicket = errors.New("invalid or expired live-update ticket")

type ticketPayload struct {
	Topic  string `json:"t"`
	Expiry int64  `json:"e"`
}

func SignTicket(key []byte, topic string, now time.Time) (string, time.Time) {
	exp := now.Add(TicketTTL)
	body, _ := json.Marshal(ticketPayload{Topic: topic, Expiry: exp.Unix()})
	p := base64.RawURLEncoding.EncodeToString(body)
	return p + "." + sign(key, p), exp
}

// VerifyTicket returns the topic of a valid, unexpired ticket.
func VerifyTicket(key []byte, ticket string, now time.Time) (string, error) {
	p, sig, ok := strings.Cut(ticket, ".")
	if !ok || len(key) == 0 || !hmac.Equal([]byte(sig), []byte(sign(key, p))) {
		return "", ErrBadTicket
	}
	body, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return "", ErrBadTicket
	}
	var t ticketPayload
	if err := json.Unmarshal(body, &t); err != nil || t.Topic == "" || now.Unix() > t.Expiry {
		return "", ErrBadTicket
	}
	if !strings.HasPrefix(t.Topic, "job:") && !strings.HasPrefix(t.Topic, "shop:") && !strings.HasPrefix(t.Topic, "order:") {
		return "", ErrBadTicket
	}
	return t.Topic, nil
}

func sign(key []byte, payload string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("cd-live-ticket:" + payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
