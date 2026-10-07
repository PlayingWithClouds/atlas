// Command atlas is the Go backend: a delegating API over source/model plugins with all state
// persisted in SurrealDB. Browse a source, open a labeling session, label the most-uncertain
// image while the model plugin's head refits, and run workflows as tracked background jobs.
//
// Usage:
//
//	atlas [workspace]              serve, with paths derived from the workspace directory
//	atlas init <dir> [--from f]    lay down a new workspace, optionally seeding its config
//
// Without a workspace atlas runs where it always did: the repo-root atlas.config.json,
// the vector pool under ~/.cache/atlas. That is legacy mode, and it is what an existing
// checkout keeps doing until it is migrated.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"atlas/backend/internal/api"
	"atlas/backend/internal/config"
	"atlas/backend/internal/db"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/registry"
	"atlas/backend/internal/workers"
	"atlas/backend/internal/workspace"
)

func main() {
	arguments := os.Args[1:]
	if len(arguments) > 0 && arguments[0] == "init" {
		if err := initWorkspace(arguments[1:]); err != nil {
			log.Fatalf("init: %v", err)
		}
		return
	}
	if err := workspace.Resolve(firstArgument(arguments)); err != nil {
		log.Fatalf("workspace: %v", err)
	}
	serve()
}

func firstArgument(arguments []string) string {
	if len(arguments) == 0 {
		return ""
	}
	return arguments[0]
}

// initWorkspace creates the directory tree and seeds its config, then says what to run
// next: the workspace is only useful once the other processes point at it too.
func initWorkspace(arguments []string) error {
	if len(arguments) == 0 {
		return fmt.Errorf("usage: atlas init <dir> [--from <config.json>]")
	}
	directory := arguments[0]
	from, err := seedFlag(arguments[1:])
	if err != nil {
		return err
	}
	if err := workspace.Init(directory, from); err != nil {
		return err
	}
	log.Printf("workspace ready at %s", workspace.Root())
	log.Printf("start atlas with: %s=%s task dev", workspace.EnvVar, workspace.Root())
	return nil
}

func seedFlag(arguments []string) (string, error) {
	if len(arguments) == 0 {
		return "", nil
	}
	if arguments[0] != "--from" || len(arguments) < 2 {
		return "", fmt.Errorf("unexpected argument %q; usage: atlas init <dir> [--from <config.json>]", arguments[0])
	}
	return arguments[1], nil
}

func serve() {
	ctx := context.Background()

	if _, err := config.Load(); err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := db.Connect(ctx); err != nil {
		log.Fatalf("db: %v", err)
	}
	defer db.Close(ctx)

	registry.Default.Load(config.Get().Plugins)
	if err := projects.Default.Load(ctx); err != nil {
		log.Fatalf("projects: %v", err)
	}

	workers.FireTrigger(workers.TriggerProgramStarted, nil)
	announceWorkspace()

	addr := os.Getenv("ATLAS_ADDR")
	if addr == "" {
		addr = ":8123"
	}
	log.Printf("atlas backend listening on %s", addr)
	if err := http.ListenAndServe(addr, api.New()); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// announceWorkspace makes the mode visible in the log. Legacy mode is easy to be in by
// accident — a shell without the variable set — and the symptom is an empty workspace,
// so it says so rather than starting silently.
func announceWorkspace() {
	if workspace.Active() {
		log.Printf("workspace %s", workspace.Root())
		return
	}
	log.Printf("no workspace: using %s and ~/.cache/atlas (pass a directory or set %s)",
		config.Get().Dir(), workspace.EnvVar)
}
