// Package hub is an in-process pub/sub bridging background workers to WebSocket clients.
// Any goroutine calls Notify() after a state change; each connected client is woken and
// pushes a fresh snapshot. Wakes are coalesced to one pending signal per client.
// Broadcast() additionally fans out one-shot event payloads (e.g. transient toasts)
// that are forwarded to clients as-is instead of triggering a snapshot.
package hub

import "sync"

// Hub fans state-change signals and one-shot events out to subscribers.
type Hub struct {
	mu               sync.Mutex
	subscribers      map[chan struct{}]struct{}
	eventSubscribers map[chan any]struct{}
}

// Default is the process-wide hub.
var Default = &Hub{
	subscribers:      map[chan struct{}]struct{}{},
	eventSubscribers: map[chan any]struct{}{},
}

// Register returns a channel that receives a signal on every Notify (buffered to 1, so a
// burst coalesces into one pending wake).
func (h *Hub) Register() chan struct{} {
	channel := make(chan struct{}, 1)
	h.mu.Lock()
	h.subscribers[channel] = struct{}{}
	h.mu.Unlock()
	return channel
}

// Unregister drops a subscriber.
func (h *Hub) Unregister(channel chan struct{}) {
	h.mu.Lock()
	delete(h.subscribers, channel)
	h.mu.Unlock()
}

// Notify signals every subscriber (non-blocking; coalesces).
func (h *Hub) Notify() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for channel := range h.subscribers {
		select {
		case channel <- struct{}{}:
		default: // already has a pending wake
		}
	}
}

// RegisterEvents returns a channel receiving every Broadcast payload. Buffered so a
// slow client drops events instead of blocking the sender.
func (h *Hub) RegisterEvents() chan any {
	channel := make(chan any, 16)
	h.mu.Lock()
	h.eventSubscribers[channel] = struct{}{}
	h.mu.Unlock()
	return channel
}

// UnregisterEvents drops an event subscriber.
func (h *Hub) UnregisterEvents(channel chan any) {
	h.mu.Lock()
	delete(h.eventSubscribers, channel)
	h.mu.Unlock()
}

// Broadcast sends a one-shot event to every event subscriber (non-blocking; a full
// subscriber misses the event).
func (h *Hub) Broadcast(event any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for channel := range h.eventSubscribers {
		select {
		case channel <- event:
		default: // subscriber backed up; drop rather than block workers
		}
	}
}
