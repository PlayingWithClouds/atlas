package notifications

import (
	"context"
	"testing"

	"atlas/backend/internal/db"
)

// Requires a running SurrealDB (the dev instance on :8020). Validates the
// Persist (create + keyed update) → List → Dismiss → Clear round trip.
func TestPersistListDismissClearLive(t *testing.T) {
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Skipf("no surreal: %v", err)
	}
	defer db.Close(ctx)

	_ = Clear(ctx)
	if err := Persist(ctx, "test-progress", "step 1", "sess-1", "info"); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if err := Persist(ctx, "test-progress", "step 2", "sess-1", "success"); err != nil {
		t.Fatalf("persist update: %v", err)
	}
	if err := Persist(ctx, "", "standalone", "sess-1", "error"); err != nil {
		t.Fatalf("persist keyless: %v", err)
	}

	list, err := List(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 notifications (keyed one updated in place), got %+v", list)
	}
	var keyed *Notification
	for i := range list {
		if list[i].Key == "test-progress" {
			keyed = &list[i]
		}
	}
	if keyed == nil || keyed.Message != "step 2" || keyed.Level != "success" || keyed.ID == "" {
		t.Fatalf("keyed notification not updated in place: %+v", list)
	}

	if err := Dismiss(ctx, keyed.ID); err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	afterDismiss, _ := List(ctx)
	if len(afterDismiss) != 1 {
		t.Fatalf("expected 1 after dismiss, got %+v", afterDismiss)
	}

	if err := Clear(ctx); err != nil {
		t.Fatalf("clear: %v", err)
	}
	afterClear, _ := List(ctx)
	if len(afterClear) != 0 {
		t.Fatalf("expected empty after clear, got %d", len(afterClear))
	}
}
