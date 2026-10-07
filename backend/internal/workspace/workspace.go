// Package workspace resolves the directory that holds one atlas project: its config,
// database, vector cache, datasets and the code the assistant writes. One workspace is
// one project — two projects never share a config file, a database or a pool directory,
// which is what keeps them from colliding.
//
// The root is chosen once at startup, from the command line or $ATLAS_WORKSPACE. Plugin
// processes read the same variable, so every part of the system derives its paths from
// one place instead of each hardcoding its own.
package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// EnvVar is the variable every process reads the workspace from. The backend sets it
// after resolving, so anything it spawns inherits the same root.
const EnvVar = "ATLAS_WORKSPACE"

// ConfigFile is the workspace's config, holding the project's taxonomy, plugins and
// workflows. It is the file the old repo-root atlas.config.json becomes.
const ConfigFile = "atlas.json"

var root string

// Use points every derived path at dir. The directory must already exist — creating one
// implicitly would turn a typo into an empty workspace rather than an error.
func Use(dir string) error {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return fmt.Errorf("workspace %s: %w (run `atlas init %s` to create it)", absolute, err, dir)
	}
	if !info.IsDir() {
		return fmt.Errorf("workspace %s is not a directory", absolute)
	}
	root = absolute
	return os.Setenv(EnvVar, absolute)
}

// Resolve picks the workspace from the command line, else the environment. Neither means
// legacy mode: paths stay where they were before workspaces existed, so an existing
// checkout keeps running until it is migrated.
func Resolve(fromCommandLine string) error {
	if fromCommandLine != "" {
		return Use(fromCommandLine)
	}
	if fromEnvironment := os.Getenv(EnvVar); fromEnvironment != "" {
		return Use(fromEnvironment)
	}
	return nil
}

// Active reports whether a workspace was resolved.
func Active() bool { return root != "" }

// Root is the workspace directory, empty in legacy mode.
func Root() string { return root }

// Config is the workspace's config file.
func Config() string { return path(ConfigFile) }

// DB is where SurrealDB keeps its files. The backend talks to surreal over a socket and
// never opens this itself; it is here because the workspace owns the layout and the
// process that does open it is started with the same variable.
func DB() string { return path("db") }

// Cache is the model plugins' vector pool root, per workspace rather than per user.
func Cache() string { return path("cache") }

// Code is the assistant's working directory: the one place it may write scripts and
// install dependencies. It is inside the workspace so that code, and the data it was
// written against, travel together.
func Code() string { return path("code") }

// Dataset is where dataset export and import read and write.
func Dataset() string { return path("dataset") }

// Exports is where labeled data and vectors are written for the assistant to read as
// files rather than page through tools.
func Exports() string { return path("exports") }

// Agent holds the assistant's own state — conversation ids and transcripts.
func Agent() string { return path("agent") }

func path(name string) string {
	if root == "" {
		return ""
	}
	return filepath.Join(root, name)
}

// directories is the tree Init lays down. Every path a running atlas writes to is in
// here, so a fresh workspace never has to create one at an awkward moment.
func directories() []string {
	return []string{DB(), Cache(), Code(), Dataset(), Exports(), Agent(), filepath.Join(Agent(), "sessions")}
}

// Init creates the workspace tree under dir and seeds its config. An existing config is
// left alone: running init twice must not overwrite a taxonomy.
//
// from copies an existing config file into the new workspace, which is how a repo-root
// atlas.config.json is migrated without moving anything.
func Init(dir, from string) error {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		return err
	}
	root = absolute
	for _, directory := range directories() {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return err
		}
	}
	return seedConfig(from)
}

func seedConfig(from string) error {
	if _, err := os.Stat(Config()); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if from == "" {
		return os.WriteFile(Config(), []byte(starterConfig), 0o644)
	}
	existing, err := os.ReadFile(from)
	if err != nil {
		return fmt.Errorf("read %s: %w", from, err)
	}
	return os.WriteFile(Config(), existing, 0o644)
}

// starterConfig is the smallest config that boots: a title, tag annotations, an empty
// taxonomy to fill in, and no plugins.
const starterConfig = `{
  "title": "atlas",
  "primitives": ["tag"],
  "labels": {
    "groups": []
  },
  "plugins": [],
  "workflows": []
}
`
