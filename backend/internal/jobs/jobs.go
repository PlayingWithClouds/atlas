// Package jobs is a background job queue with SurrealDB-persisted status. Every long task
// (embed, extract, model-tag, review, export) is a Job that survives restarts: a job left
// "running" by a crashed process is swept to "interrupted" on boot (see internal/db).
package jobs

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"atlas/backend/internal/db"
	"atlas/backend/internal/hub"
)

const (
	maxWorkers      = 3
	persistInterval = 400 * time.Millisecond
)

// JobView is the serializable snapshot of a job.
type JobView struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	SessionID string         `json:"session_id"`
	Phase     string         `json:"phase"`
	Done      int            `json:"done"`
	Total     int            `json:"total"`
	State     string         `json:"state"`
	Error     string         `json:"error"`
	Extra     map[string]any `json:"extra"`
	Created   float64        `json:"created"`
	Updated   float64        `json:"updated"`
}

// Job is a live job handle updated by its worker.
type Job struct {
	mu          sync.Mutex
	view        JobView
	lastPersist time.Time
}

// Manager runs and tracks jobs.
type Manager struct {
	sem     chan struct{}
	counter atomic.Int64
}

// Default is the process-wide job manager.
var Default = &Manager{sem: make(chan struct{}, maxWorkers)}

func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// Submit creates a job, runs fn(job) on the worker pool, and returns the job immediately.
func (m *Manager) Submit(typ, sessionID string, total int, extra map[string]any, fn func(*Job) error) *Job {
	if extra == nil {
		extra = map[string]any{}
	}
	id := fmt.Sprintf("job-%d-%d", time.Now().UnixMilli(), m.counter.Add(1))
	job := &Job{view: JobView{
		ID: id, Type: typ, SessionID: sessionID, Total: total, Extra: extra,
		State: "running", Created: now(), Updated: now(),
	}}
	job.persist(true)

	go func() {
		m.sem <- struct{}{}
		defer func() { <-m.sem }()
		if err := fn(job); err != nil {
			job.Update(map[string]any{"state": "error", "error": err.Error()})
			return
		}
		job.Update(map[string]any{"state": "done"})
	}()
	return job
}

// Update applies field changes and force-persists.
func (j *Job) Update(fields map[string]any) {
	j.mu.Lock()
	for key, value := range fields {
		switch key {
		case "phase":
			j.view.Phase, _ = value.(string)
		case "state":
			j.view.State, _ = value.(string)
		case "error":
			j.view.Error, _ = value.(string)
		case "done":
			if v, ok := value.(int); ok {
				j.view.Done = v
			}
		case "total":
			if v, ok := value.(int); ok {
				j.view.Total = v
			}
		}
	}
	j.mu.Unlock()
	j.persist(true)
}

// Tick advances progress by count (throttled persist).
func (j *Job) Tick(count int) {
	j.mu.Lock()
	j.view.Done += count
	j.mu.Unlock()
	j.persist(false)
}

// View returns a snapshot of the job's current state.
func (j *Job) View() JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.view
}

// SessionID exposes the job's session id (for workers).
func (j *Job) SessionID() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.view.SessionID
}

func (j *Job) persist(force bool) {
	j.mu.Lock()
	if !force && time.Since(j.lastPersist) < persistInterval {
		j.mu.Unlock()
		return
	}
	j.lastPersist = time.Now()
	j.view.Updated = now()
	view := j.view
	j.mu.Unlock()

	_ = db.Exec(context.Background(),
		"UPSERT type::record('job', $id) SET type=$type, session_id=$sid, phase=$phase, done=$done, total=$total, state=$state, error=$error, extra=$extra, created=$created, updated=$updated",
		map[string]any{
			"id": view.ID, "type": view.Type, "sid": view.SessionID, "phase": view.Phase,
			"done": view.Done, "total": view.Total, "state": view.State, "error": view.Error,
			"extra": view.Extra, "created": view.Created, "updated": view.Updated,
		})
	hub.Default.Notify()
}

const selectFields = "SELECT meta::id(id) AS id, type, session_id, phase, done, total, state, error, extra, created, updated FROM job"

// List returns jobs, optionally filtered by session and/or to active (running) only.
func (m *Manager) List(ctx context.Context, sessionID string, active bool) ([]JobView, error) {
	query := selectFields
	vars := map[string]any{}
	var conditions []string
	if sessionID != "" {
		conditions = append(conditions, "session_id=$sid")
		vars["sid"] = sessionID
	}
	if active {
		conditions = append(conditions, "state='running'")
	}
	if len(conditions) > 0 {
		query += " WHERE " + conditions[0]
		for _, condition := range conditions[1:] {
			query += " AND " + condition
		}
	}
	query += " ORDER BY created DESC"
	rows, err := db.Query[JobView](ctx, query, vars)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		return []JobView{}, nil
	}
	return rows, nil
}

// Get returns one job by id, or nil.
func (m *Manager) Get(ctx context.Context, id string) (*JobView, error) {
	rows, err := db.Query[JobView](ctx, selectFields+" WHERE id=type::record('job', $id)", map[string]any{"id": id})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// Running reports whether a job of the given type is running for a session.
func (m *Manager) Running(ctx context.Context, typ, sessionID string) bool {
	rows, err := db.Query[struct {
		Count int `json:"count"`
	}](ctx, "SELECT count() AS count FROM job WHERE type=$type AND session_id=$sid AND state='running' GROUP ALL",
		map[string]any{"type": typ, "sid": sessionID})
	if err != nil || len(rows) == 0 {
		return false
	}
	return rows[0].Count > 0
}
