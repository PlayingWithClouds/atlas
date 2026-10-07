package projects

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The default project must mirror atlas.config.json live (no DB copy), so
// taxonomy edits show up after a restart.
func TestDefaultProjectComesFromConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "atlas.config.json")
	configJSON := `{
		"title": "test-atlas",
		"primitives": ["tag"],
		"labels": {"groups": [
			{"id": "acts", "classes": [{"name": "one"}, {"name": "two"}]},
			{"id": "extra", "classes": [{"name": "three"}]}
		]}
	}`
	if err := os.WriteFile(configPath, []byte(configJSON), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("ATLAS_CONFIG", configPath)

	project, err := Default.Get(context.Background(), DefaultProject)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if project == nil {
		t.Fatal("default project missing")
	}
	if project.Name != "test-atlas" {
		t.Fatalf("expected config title as name, got %q", project.Name)
	}
	expected := []string{"one", "two", "three"}
	if !reflect.DeepEqual(project.Classes(), expected) {
		t.Fatalf("expected classes %v, got %v", expected, project.Classes())
	}
}
