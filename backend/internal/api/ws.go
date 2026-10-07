package api

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/notifications"
	"atlas/backend/internal/registry"
	"atlas/backend/internal/sessions"
)

// handleWebSocket pushes a jobs/sessions/plugins snapshot on every state change (no polling).
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	// The request context is not cancelled when a hijacked connection dies, so without
	// this a closed tab leaves a subscriber that every Notify still writes to. CloseRead
	// reads in the background and cancels ctx as soon as the peer goes away — it also
	// answers pings and close frames, which this handler otherwise never would.
	ctx := conn.CloseRead(r.Context())
	channel := hub.Default.Register()
	defer hub.Default.Unregister(channel)
	events := hub.Default.RegisterEvents()
	defer hub.Default.UnregisterEvents(events)

	if err := pushSnapshot(ctx, conn); err != nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-channel:
			if err := pushSnapshot(ctx, conn); err != nil {
				return
			}
		case event := <-events:
			if err := pushEvent(ctx, conn, event); err != nil {
				return
			}
		}
	}
}

// pushEvent forwards a one-shot hub event (e.g. a transient toast) verbatim.
func pushEvent(ctx context.Context, conn *websocket.Conn, event any) error {
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return wsjson.Write(writeCtx, conn, event)
}

func pushSnapshot(ctx context.Context, conn *websocket.Conn) error {
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return wsjson.Write(writeCtx, conn, snapshot(ctx))
}

// snapshot is the whole live state a client needs.
func snapshot(ctx context.Context) map[string]any {
	jobList, _ := jobs.Default.List(ctx, "", false)
	sessionList, _ := sessions.Default.List(ctx, "")
	notificationList, _ := notifications.List(ctx)
	return map[string]any{
		"type":          "state",
		"jobs":          jobList,
		"sessions":      sessionList,
		"plugins":       registry.Default.Status(),
		"notifications": notificationList,
	}
}
