// Package notifications delivers user-facing messages in two kinds:
//
//   - Persistent: stored in SurrealDB keyed by a stable string, so callers can
//     update one in place (e.g. ingest progress). They survive a reload, are
//     pushed with the live WebSocket snapshot, and stay in the notification
//     tray until the user dismisses them.
//   - Transient (toasts): never stored. Broadcast once over the live socket
//     and shown by the UI for a few seconds.
package notifications

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"

	"atlas/backend/internal/db"
	"atlas/backend/internal/hub"
)

// Notification is one persistent tray entry.
type Notification struct {
	ID      string `json:"id"`
	Key     string `json:"key"`
	Message string `json:"message"`
	Session string `json:"session,omitempty"`
	Level   string `json:"level,omitempty"` // info | success | error
	Created string `json:"created"`
	Updated string `json:"updated"`
}

// Toast is one transient notification, broadcast over the live socket only.
type Toast struct {
	ID      string `json:"id"`
	Message string `json:"message"`
	Session string `json:"session,omitempty"`
	Level   string `json:"level,omitempty"`
}

func randomKey() string {
	buffer := make([]byte, 8)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// Persist creates or updates the persistent notification identified by key and
// wakes live clients. An empty key creates a standalone entry that is never
// updated afterwards. The session column is named "sid" because "session" is a
// protected identifier in SurrealDB.
func Persist(ctx context.Context, key, message, session, level string) error {
	if key == "" {
		key = randomKey()
	}
	err := db.Exec(ctx,
		"UPSERT notification SET key=$key, message=$message, sid=$sid, level=$level, updated=time::now(), created=created OR time::now() WHERE key=$key",
		map[string]any{"key": key, "message": message, "sid": session, "level": level})
	if err != nil {
		return err
	}
	hub.Default.Notify()
	return nil
}

// Notify broadcasts a transient toast to connected clients. Nothing is stored;
// a client that is not connected right now simply misses it.
func Notify(message, session, level string) {
	hub.Default.Broadcast(map[string]any{
		"type":  "toast",
		"toast": Toast{ID: randomKey(), Message: message, Session: session, Level: level},
	})
}

// List returns persistent notifications, oldest first, with string ids.
func List(ctx context.Context) ([]Notification, error) {
	return db.Query[Notification](ctx,
		"SELECT type::string(id) AS id, key, message, sid AS session, level, type::string(created) AS created, type::string(updated) AS updated FROM notification ORDER BY created", nil)
}

// Dismiss removes one persistent notification by its string id ("notification:xyz").
func Dismiss(ctx context.Context, id string) error {
	recordID := strings.TrimPrefix(id, "notification:")
	// Surreal wraps non-numeric ids in ⟨⟩ when stringified; strip so type::record resolves.
	recordID = strings.Trim(recordID, "⟨⟩")
	err := db.Exec(ctx, "DELETE type::record('notification', $id)", map[string]any{"id": recordID})
	if err != nil {
		return err
	}
	hub.Default.Notify()
	return nil
}

// Clear removes all persistent notifications.
func Clear(ctx context.Context) error {
	err := db.Exec(ctx, "DELETE notification", nil)
	if err != nil {
		return err
	}
	hub.Default.Notify()
	return nil
}
