// Package config loads the deployment-level startup config: app title, label taxonomy
// (groups → classes), enabled annotation primitives, the plugin registry, and saved
// workflows. Read-only at runtime.
//
// With a workspace the file is <workspace>/atlas.json; without one it is the repo-root
// atlas.config.json it used to be.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"atlas/backend/internal/workspace"
)

// saveMu serializes writes back to the config file.
var saveMu sync.Mutex

// PluginConfig is one entry in the plugin registry.
type PluginConfig struct {
	ID     string         `json:"id"`
	URL    string         `json:"url"`
	Config map[string]any `json:"config,omitempty"`
}

// NodePos is a node's position on the designer canvas.
type NodePos struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// WorkflowNode is one processing node in a workflow graph.
type WorkflowNode struct {
	ID     string         `json:"id"`
	Type   string         `json:"type"`
	Params map[string]any `json:"params,omitempty"`
	Pos    NodePos        `json:"pos"`
}

// WorkflowEdge connects one node's output port to another node's input port.
type WorkflowEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

// WorkflowGraph is the node-graph authored in the visual designer.
type WorkflowGraph struct {
	Nodes []WorkflowNode `json:"nodes"`
	Edges []WorkflowEdge `json:"edges"`
}

// Workflow is a designer-authored node graph run over a session. Triggers decide
// when it runs: "manual" (the Run button) or one or more lifecycle events.
type Workflow struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Project owns the workflow. A graph is written against one project's content
	// kind and model backbone, so it only runs for that project's sessions. Empty
	// means a workflow saved before scoping existed: it still runs everywhere, and
	// picks up an owner the next time the designer saves it.
	Project  string         `json:"project,omitempty"`
	Triggers []string       `json:"triggers"`
	Graph    *WorkflowGraph `json:"graph,omitempty"`
}

// RunsFor reports whether this workflow applies to a session in the given project.
func (w Workflow) RunsFor(project string) bool {
	return w.Project == "" || w.Project == project
}

// Assistant configures the in-app labeling assistant. It is off unless enabled: the
// backend should not reach for an ollama that may not be there.
type Assistant struct {
	Enabled bool `json:"enabled"`
	// Backend picks who runs the turn: "ollama" (default) drives a bounded tool loop
	// against a local model, "claude" hands the whole turn to the Claude Code CLI.
	Backend string `json:"backend"`
	URL     string `json:"url"`   // ollama base URL, default http://localhost:11434
	Model   string `json:"model"` // the tool-calling model
	// VisionModel answers "what does this look like" for contact sheets. It is separate
	// because small local models are unreliable at tool use and vision at once, so the
	// tool-calling model never receives an image — it calls a tool that asks this one.
	VisionModel  string `json:"vision_model"`
	MaxToolCalls int    `json:"max_tool_calls"`
	Claude       Claude `json:"claude"`
}

// Claude configures the Claude Code backend. That CLI is already an agent — it calls
// atlas's own MCP server over HTTP and runs code in the workspace — so atlas spawns it
// and reads its event stream rather than driving a tool loop itself.
type Claude struct {
	Binary string `json:"binary"` // default "claude"
	Model  string `json:"model"`  // alias or full name; empty uses the CLI's default
	// MCPURL is where the CLI reaches atlas's tools. It is the running backend's own
	// address, so it is configured rather than guessed.
	MCPURL string `json:"mcp_url"`
	// Tools is the built-in tool set the CLI may use; AllowedTools is the permission
	// list, which is what actually gates a call. Both default to a read-write set
	// scoped to the workspace — see assistant.Settings.
	Tools        []string `json:"tools"`
	AllowedTools []string `json:"allowed_tools"`
	MaxBudgetUSD float64  `json:"max_budget_usd"`
	// TimeoutSeconds bounds one turn. An agentic turn is minutes, not seconds.
	TimeoutSeconds int `json:"timeout_seconds"`
}

// Config is the parsed atlas.config.json.
type Config struct {
	Title      string          `json:"title"`
	Primitives []string        `json:"primitives"`
	Labels     json.RawMessage `json:"labels"`
	Plugins    []PluginConfig  `json:"plugins"`
	Workflows  []Workflow      `json:"workflows"`
	Device     string          `json:"device"`
	Assistant  Assistant       `json:"assistant"`

	path string
}

var loaded *Config

// Load reads and caches the config. Path resolution: $ATLAS_CONFIG, else ./atlas.config.json,
// else ../atlas.config.json (the backend runs from backend/).
func Load() (*Config, error) {
	if loaded != nil {
		return loaded, nil
	}
	return load()
}

// Reload re-reads the config file, replacing the cache. A parse failure keeps
// the previously loaded config.
func Reload() (*Config, error) {
	return load()
}

func load() (*Config, error) {
	path := resolvePath()
	config := &Config{
		Title:      "atlas",
		Primitives: []string{"tag"},
		path:       path,
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			loaded = config
			return config, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, config); err != nil {
		return nil, err
	}
	if config.Title == "" {
		config.Title = "atlas"
	}
	if len(config.Primitives) == 0 {
		config.Primitives = []string{"tag"}
	}
	config.path = path
	loaded = config
	return config, nil
}

// Get returns the loaded config (loading it if needed). Panics only on a malformed file.
func Get() *Config {
	if loaded == nil {
		if _, err := Load(); err != nil {
			panic(err)
		}
	}
	return loaded
}

func resolvePath() string {
	if env := os.Getenv("ATLAS_CONFIG"); env != "" {
		return env
	}
	// A workspace owns its config, so nothing is searched for: the file belongs at a
	// known path whether or not it exists yet.
	if workspace.Active() {
		return workspace.Config()
	}
	for _, candidate := range []string{"atlas.config.json", filepath.Join("..", "atlas.config.json")} {
		if _, err := os.Stat(candidate); err == nil {
			abs, absErr := filepath.Abs(candidate)
			if absErr == nil {
				return abs
			}
			return candidate
		}
	}
	return "atlas.config.json"
}

type labelClass struct {
	Name string `json:"name"`
}

type labelGroup struct {
	Classes []labelClass `json:"classes"`
}

type labelSchema struct {
	Groups []labelGroup `json:"groups"`
}

// DefaultClasses returns the flattened class names in config order.
func (c *Config) DefaultClasses() []string {
	if len(c.Labels) == 0 {
		return nil
	}
	var schema labelSchema
	if err := json.Unmarshal(c.Labels, &schema); err != nil {
		return nil
	}
	var classes []string
	for _, group := range schema.Groups {
		for _, class := range group.Classes {
			classes = append(classes, class.Name)
		}
	}
	return classes
}

// Dir returns the directory containing the config file (the repo root).
func (c *Config) Dir() string {
	return filepath.Dir(c.path)
}

// Workflow returns the workflow with the given id, or nil.
func (c *Config) Workflow(id string) *Workflow {
	for i := range c.Workflows {
		if c.Workflows[i].ID == id {
			return &c.Workflows[i]
		}
	}
	return nil
}

// SaveWorkflows replaces the workflow list and persists the whole config back to
// atlas.config.json. The struct fields mirror the file exactly, so re-marshaling
// is lossless; Labels stays verbatim because it is a json.RawMessage.
func (c *Config) SaveWorkflows(list []Workflow) error {
	saveMu.Lock()
	defer saveMu.Unlock()

	c.Workflows = list
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	temp := c.path + ".tmp"
	if err := os.WriteFile(temp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(temp, c.path)
}
