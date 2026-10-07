package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// reset clears the resolved root so each test starts from legacy mode.
func reset(t *testing.T) {
	t.Cleanup(func() { root = "" })
	root = ""
	t.Setenv(EnvVar, "")
}

func TestInitLaysDownTheTree(t *testing.T) {
	reset(t)
	directory := filepath.Join(t.TempDir(), "workspace")

	if err := Init(directory, ""); err != nil {
		t.Fatalf("init: %v", err)
	}
	for _, expected := range directories() {
		info, err := os.Stat(expected)
		if err != nil {
			t.Fatalf("stat %s: %v", expected, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", expected)
		}
	}

	data, err := os.ReadFile(Config())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var seeded map[string]any
	if err := json.Unmarshal(data, &seeded); err != nil {
		t.Fatalf("seeded config is not JSON: %v", err)
	}
	if seeded["title"] != "atlas" {
		t.Fatalf("title = %v, want atlas", seeded["title"])
	}
}

func TestInitKeepsAnExistingConfig(t *testing.T) {
	reset(t)
	directory := t.TempDir()
	if err := Init(directory, ""); err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := os.WriteFile(Config(), []byte(`{"title":"mine"}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := Init(directory, ""); err != nil {
		t.Fatalf("second init: %v", err)
	}
	data, err := os.ReadFile(Config())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(data) != `{"title":"mine"}` {
		t.Fatalf("config was overwritten: %s", data)
	}
}

func TestInitSeedsFromAnExistingConfig(t *testing.T) {
	reset(t)
	source := filepath.Join(t.TempDir(), "atlas.config.json")
	if err := os.WriteFile(source, []byte(`{"title":"migrated"}`), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	if err := Init(filepath.Join(t.TempDir(), "workspace"), source); err != nil {
		t.Fatalf("init: %v", err)
	}
	data, err := os.ReadFile(Config())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(data) != `{"title":"migrated"}` {
		t.Fatalf("config = %s, want the migrated one", data)
	}
}

func TestResolvePrefersTheCommandLine(t *testing.T) {
	reset(t)
	fromEnvironment := t.TempDir()
	fromCommandLine := t.TempDir()
	t.Setenv(EnvVar, fromEnvironment)

	if err := Resolve(fromCommandLine); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if Root() != fromCommandLine {
		t.Fatalf("root = %s, want %s", Root(), fromCommandLine)
	}
	// Resolving must publish the choice, or plugins started later read the stale one.
	if os.Getenv(EnvVar) != fromCommandLine {
		t.Fatalf("%s = %s, want %s", EnvVar, os.Getenv(EnvVar), fromCommandLine)
	}
}

func TestResolveFallsBackToLegacyMode(t *testing.T) {
	reset(t)
	if err := Resolve(""); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if Active() {
		t.Fatalf("root = %s, want legacy mode", Root())
	}
	if Config() != "" {
		t.Fatalf("config = %s, want empty in legacy mode", Config())
	}
}

func TestUseRejectsAMissingDirectory(t *testing.T) {
	reset(t)
	if err := Use(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected an error for a directory that does not exist")
	}
	if Active() {
		t.Fatalf("root = %s, want unset after a failed Use", Root())
	}
}

func TestUseRejectsAFile(t *testing.T) {
	reset(t)
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := Use(file); err == nil {
		t.Fatal("expected an error for a file")
	}
}
