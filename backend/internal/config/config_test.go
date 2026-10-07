package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSaveWorkflowsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "atlas.config.json")

	cfg := &Config{
		Title:      "atlas",
		Primitives: []string{"tag"},
		Labels:     json.RawMessage(`{"groups":[{"id":"acts","classes":[{"name":"solo"}]}]}`),
		path:       path,
	}

	workflows := []Workflow{{
		ID:       "tag-flow",
		Label:    "Tag flow",
		Triggers: []string{"session_created"},
		Graph: &WorkflowGraph{
			Nodes: []WorkflowNode{
				{ID: "source-0", Type: "source", Pos: NodePos{X: 10, Y: 20}},
				{ID: "predict-1", Type: "predict", Params: map[string]any{"threshold": 0.6}, Pos: NodePos{X: 200, Y: 20}},
			},
			Edges: []WorkflowEdge{{Source: "source-0", Target: "predict-1"}},
		},
	}}

	if err := cfg.SaveWorkflows(workflows); err != nil {
		t.Fatalf("save: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var reloaded Config
	if err := json.Unmarshal(data, &reloaded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(reloaded.Workflows) != 1 {
		t.Fatalf("got %d workflows, want 1", len(reloaded.Workflows))
	}
	got := reloaded.Workflows[0]
	if got.ID != "tag-flow" || got.Graph == nil || len(got.Graph.Nodes) != 2 {
		t.Fatalf("workflow not persisted correctly: %+v", got)
	}
	if !reflect.DeepEqual(got.Graph.Edges, workflows[0].Graph.Edges) {
		t.Fatalf("edges mismatch: %+v", got.Graph.Edges)
	}
	// Labels (a RawMessage) must survive verbatim.
	if len(reloaded.Labels) == 0 {
		t.Fatal("labels lost on round-trip")
	}
}

func TestWorkflowRunsForScopesToItsProject(t *testing.T) {
	owned := Workflow{ID: "segment", Project: "porn-videos"}
	if !owned.RunsFor("porn-videos") {
		t.Error("a workflow must run for the project that owns it")
	}
	if owned.RunsFor("nsfw-tags") {
		t.Error("a clip workflow ran for an image project; its nodes target another backbone")
	}

	// Written before workflows carried an owner: keeps running everywhere so an
	// upgrade does not silently stop existing automation.
	legacy := Workflow{ID: "old"}
	if !legacy.RunsFor("porn-videos") || !legacy.RunsFor("nsfw-tags") {
		t.Error("an unscoped workflow must still run for every project")
	}
}

func TestSaveWorkflowsKeepsTheProject(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "atlas.config.json")
	cfg := &Config{Title: "atlas", Primitives: []string{"tag"}, Labels: json.RawMessage(`{}`), path: path}

	if err := cfg.SaveWorkflows([]Workflow{{ID: "w", Label: "W", Project: "porn-videos"}}); err != nil {
		t.Fatalf("save: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var reloaded Config
	if err := json.Unmarshal(data, &reloaded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(reloaded.Workflows) != 1 || reloaded.Workflows[0].Project != "porn-videos" {
		t.Fatalf("reloaded project = %+v, want it preserved across a save", reloaded.Workflows)
	}
}
