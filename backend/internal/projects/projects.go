// Package projects manages labeling projects — each a task with its own label schema,
// primitives, data, and training pool. Backed by the `project` table in SurrealDB. The
// default project `nsfw-tags` is seeded from atlas.config.json.
package projects

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"atlas/backend/internal/config"
	"atlas/backend/internal/db"
)

const DefaultProject = "nsfw-tags"

var regionTypes = map[string]bool{"rect": true, "polygon": true, "keypoint": true, "mask": true}

// Project is a labeling task definition.
type Project struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Config  map[string]any `json:"config"`
	Created string         `json:"created"`
	Updated string         `json:"updated"`
}

// Primitives lists the enabled annotation primitives (default ["tag"]).
func (p *Project) Primitives() []string {
	raw, ok := p.Config["primitives"].([]any)
	if !ok {
		return []string{"tag"}
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if str, ok := item.(string); ok {
			out = append(out, str)
		}
	}
	if len(out) == 0 {
		return []string{"tag"}
	}
	return out
}

// Labels returns the raw label schema ({groups: [...]}).
func (p *Project) Labels() map[string]any {
	if labels, ok := p.Config["labels"].(map[string]any); ok {
		return labels
	}
	return map[string]any{"groups": []any{}}
}

// Classes returns the flattened class names.
func (p *Project) Classes() []string {
	var out []string
	groups, _ := p.Labels()["groups"].([]any)
	for _, groupAny := range groups {
		group, ok := groupAny.(map[string]any)
		if !ok {
			continue
		}
		classes, _ := group["classes"].([]any)
		for _, classAny := range classes {
			class, ok := classAny.(map[string]any)
			if !ok {
				continue
			}
			if name, ok := class["name"].(string); ok {
				out = append(out, name)
			}
		}
	}
	return out
}

// Model returns the id of the model plugin serving this project (embedding backbone
// + pool + classifier). Defaults to "model"; a video/temporal project sets "siglip".
func (p *Project) Model() string {
	if value, ok := p.Config["model"].(string); ok && value != "" {
		return value
	}
	return "model"
}

// ContentKind is what this project's entities are: "image" (stills and extracted
// frames) or "video" (temporal clip spans). It selects which labeler the UI mounts.
func (p *Project) ContentKind() string {
	if value, ok := p.Config["contentKind"].(string); ok && value == "video" {
		return "video"
	}
	return "image"
}

// IsTag reports whether the project labels with tags.
func (p *Project) IsTag() bool {
	for _, primitive := range p.Primitives() {
		if primitive == "tag" {
			return true
		}
	}
	return false
}

// IsRegion reports whether the project uses region primitives.
func (p *Project) IsRegion() bool {
	for _, primitive := range p.Primitives() {
		if regionTypes[primitive] {
			return true
		}
	}
	return false
}

// ToDict is the full serialization (for GET /api/projects/{id}).
func (p *Project) ToDict() map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "config": p.Config,
		"created": p.Created, "updated": p.Updated,
	}
}

// Summary is the compact serialization (for GET /api/projects).
func (p *Project) Summary() map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name,
		"primitives": p.Primitives(), "classes": len(p.Classes()),
		"contentKind": p.ContentKind(),
	}
}

// Manager is the project registry over SurrealDB.
type Manager struct{}

// Default is the process-wide project manager.
var Default = &Manager{}

const selectFields = "SELECT meta::id(id) AS id, name, config, created, updated FROM"

// Load removes the legacy DB copy of the default project. Its schema now comes
// live from atlas.config.json (see defaultProject), so config edits are picked
// up on restart instead of being frozen at first seed.
func (m *Manager) Load(ctx context.Context) error {
	return db.Exec(ctx, "DELETE type::record('project', $id)", map[string]any{"id": DefaultProject})
}

// defaultProject builds the config-file-backed default project. Never stored.
func defaultProject() *Project {
	cfg := config.Get()
	var labels map[string]any
	if len(cfg.Labels) > 0 {
		labels = rawToMap(cfg.Labels)
	}
	if labels == nil {
		labels = map[string]any{"groups": []any{}}
	}
	name := cfg.Title
	if name == "" {
		name = "atlas"
	}
	return &Project{
		ID:   DefaultProject,
		Name: name,
		Config: map[string]any{
			"primitives": toAnySlice(cfg.Primitives),
			"labels":     labels,
			"source":     map[string]any{},
		},
	}
}

// List returns compact summaries: the config-backed default project first,
// then the user-created ones from the DB.
func (m *Manager) List(ctx context.Context) ([]map[string]any, error) {
	projects, err := m.all(ctx)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{defaultProject().Summary()}
	for _, project := range projects {
		if project.ID == DefaultProject {
			continue
		}
		out = append(out, project.Summary())
	}
	return out, nil
}

func (m *Manager) all(ctx context.Context) ([]Project, error) {
	return db.Query[Project](ctx, selectFields+" project", nil)
}

// Get returns a project by id, or nil if missing. The default project is built
// from atlas.config.json, never read from the DB.
func (m *Manager) Get(ctx context.Context, id string) (*Project, error) {
	if id == DefaultProject {
		return defaultProject(), nil
	}
	rows, err := db.Query[Project](ctx, selectFields+" type::record('project', $id)", map[string]any{"id": id})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// Create makes a new project with a slug id derived from the name.
func (m *Manager) Create(ctx context.Context, name string, cfg map[string]any) (*Project, error) {
	id, err := m.uniqueID(ctx, name)
	if err != nil {
		return nil, err
	}
	configBlock := map[string]any{
		"primitives":  pick(cfg, "primitives", []any{"tag"}),
		"labels":      pick(cfg, "labels", map[string]any{"groups": []any{}}),
		"source":      pick(cfg, "source", map[string]any{}),
		"model":       pick(cfg, "model", "model"),
		"contentKind": pick(cfg, "contentKind", "image"),
	}
	if err := db.Exec(ctx,
		"CREATE type::record('project', $id) SET name=$name, config=$config, created=<string>time::now(), updated=<string>time::now()",
		map[string]any{"id": id, "name": name, "config": configBlock}); err != nil {
		return nil, err
	}
	return m.Get(ctx, id)
}

// Update patches a project's name and/or config keys. The default project is
// owned by atlas.config.json and cannot be edited here.
func (m *Manager) Update(ctx context.Context, id string, fields map[string]any) (*Project, error) {
	if id == DefaultProject {
		return nil, fmt.Errorf("project %q is defined in atlas.config.json; edit the file instead", id)
	}
	project, err := m.Get(ctx, id)
	if err != nil || project == nil {
		return nil, err
	}
	for _, key := range []string{"primitives", "labels", "source", "model", "contentKind"} {
		if value, ok := fields[key]; ok {
			project.Config[key] = value
		}
	}
	name := project.Name
	if value, ok := fields["name"].(string); ok {
		name = value
	}
	if err := db.Exec(ctx,
		"UPDATE type::record('project', $id) SET name=$name, config=$config, updated=<string>time::now()",
		map[string]any{"id": id, "name": name, "config": project.Config}); err != nil {
		return nil, err
	}
	return m.Get(ctx, id)
}

// Delete removes a project definition (refuses the default). Session/image data is left.
func (m *Manager) Delete(ctx context.Context, id string) (bool, error) {
	if id == DefaultProject {
		return false, nil
	}
	project, err := m.Get(ctx, id)
	if err != nil || project == nil {
		return false, err
	}
	if err := db.Exec(ctx, "DELETE type::record('project', $id)", map[string]any{"id": id}); err != nil {
		return false, err
	}
	return true, nil
}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

func (m *Manager) uniqueID(ctx context.Context, name string) (string, error) {
	base := strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if base == "" {
		base = "project"
	}
	candidate := base
	for suffix := 2; ; suffix++ {
		existing, err := m.Get(ctx, candidate)
		if err != nil {
			return "", err
		}
		if existing == nil {
			return candidate, nil
		}
		candidate = fmt.Sprintf("%s-%d", base, suffix)
	}
}

func toAnySlice(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}

func pick(cfg map[string]any, key string, fallback any) any {
	if cfg != nil {
		if value, ok := cfg[key]; ok {
			return value
		}
	}
	return fallback
}

func rawToMap(raw []byte) map[string]any {
	// config.Labels is json.RawMessage; decode via db-free json.
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
