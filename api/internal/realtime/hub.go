// Package realtime pushes live updates to open ticket pages and shop boards with Server-Sent Events.
// SSE (not WebSocket) keeps the MVP dependency-free and works through proxies; clients act over
// normal HTTP calls. Single-instance fan-out: run one API process (see docs/CODE-STATUS.md).
package realtime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type Event struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

// Message is an event addressed to a topic (job:<id> or shop:<id>).
type Message struct {
	Topic string
	Event Event
}

// Publisher sends events to everyone watching a topic. The in-process Hub (SSE, and the local
// WebSocket emulation) implements it; on AWS, events come from the DynamoDB stream instead.
type Publisher interface {
	Publish(topic string, ev Event)
}

var _ Publisher = (*Hub)(nil)

type subscriber chan []byte

type Hub struct {
	mu     sync.RWMutex
	topics map[string]map[subscriber]struct{}
}

func NewHub() *Hub { return &Hub{topics: map[string]map[subscriber]struct{}{}} }

func JobTopic(id string) string  { return "job:" + id }
func ShopTopic(id string) string { return "shop:" + id }

// OrderTopic carries updates for one multi-day order (the customer's order page).
func OrderTopic(id string) string { return "order:" + id }

// Publish sends an event to every subscriber of the topic. Slow subscribers are skipped, not waited on.
func (h *Hub) Publish(topic string, ev Event) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for sub := range h.topics[topic] {
		select {
		case sub <- b:
		default:
		}
	}
}

func (h *Hub) subscribe(topic string) subscriber {
	sub := make(subscriber, 32)
	h.mu.Lock()
	if h.topics[topic] == nil {
		h.topics[topic] = map[subscriber]struct{}{}
	}
	h.topics[topic][sub] = struct{}{}
	h.mu.Unlock()
	return sub
}

func (h *Hub) unsubscribe(topic string, sub subscriber) {
	h.mu.Lock()
	delete(h.topics[topic], sub)
	if len(h.topics[topic]) == 0 {
		delete(h.topics, topic)
	}
	h.mu.Unlock()
}

// Subscribe returns a channel of encoded events for a topic and a function to stop listening.
// Slow readers miss events rather than block publishers (the client refetches on reconnect).
func (h *Hub) Subscribe(topic string) (<-chan []byte, func()) {
	sub := h.subscribe(topic)
	return sub, func() { h.unsubscribe(topic, sub) }
}

// Count returns the number of open connections (metrics / tests).
func (h *Hub) Count(topic string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.topics[topic])
}

// Serve streams a topic until the client disconnects. A "hello" event is sent first and a
// comment ping every 20 s keeps proxies from closing the connection.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, topic string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	sub := h.subscribe(topic)
	defer h.unsubscribe(topic, sub)

	fmt.Fprint(w, "retry: 3000\nevent: message\ndata: {\"type\":\"hello\"}\n\n")
	flusher.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case b := <-sub:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
			flusher.Flush()
		}
	}
}
