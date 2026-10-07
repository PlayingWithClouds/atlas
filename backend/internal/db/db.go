// Package db owns the SurrealDB connection, schema bootstrap, generic query helpers, and
// the crash-recovery sweep. All backend state (projects, sessions, images, jobs, settings)
// lives in SurrealDB — this replaces the old per-session JSON files. Big binary blobs (video
// frames, the model plugin's vector pool) stay on disk; Surreal stores refs/paths to them.
package db

import (
	"context"
	"fmt"
	"os"

	"github.com/surrealdb/surrealdb.go"
)

const defaultURL = "ws://127.0.0.1:8020/rpc"

var conn *surrealdb.DB

// Connect opens the connection, authenticates, selects the atlas namespace/database,
// bootstraps the schema, and runs the crash-recovery sweep. URL from $ATLAS_SURREAL_URL.
func Connect(ctx context.Context) error {
	url := os.Getenv("ATLAS_SURREAL_URL")
	if url == "" {
		url = defaultURL
	}
	client, err := surrealdb.Connect(ctx, url)
	if err != nil {
		return fmt.Errorf("surreal connect %s: %w", url, err)
	}
	if _, err := client.SignIn(ctx, surrealdb.Auth{Username: "root", Password: "root"}); err != nil {
		return fmt.Errorf("surreal signin: %w", err)
	}
	if err := client.Use(ctx, "atlas", "atlas"); err != nil {
		return fmt.Errorf("surreal use: %w", err)
	}
	conn = client

	if err := bootstrap(ctx); err != nil {
		return err
	}
	return recoverJobs(ctx)
}

// Close closes the connection.
func Close(ctx context.Context) {
	if conn != nil {
		_ = conn.Close(ctx)
	}
}

func bootstrap(ctx context.Context) error {
	statements := []string{
		"DEFINE TABLE IF NOT EXISTS project",
		"DEFINE TABLE IF NOT EXISTS session",
		"DEFINE TABLE IF NOT EXISTS image",
		"DEFINE TABLE IF NOT EXISTS job",
		"DEFINE TABLE IF NOT EXISTS setting",
		"DEFINE TABLE IF NOT EXISTS notification",
		"DEFINE INDEX IF NOT EXISTS image_session ON TABLE image COLUMNS session",
		"DEFINE INDEX IF NOT EXISTS image_session_idx ON TABLE image COLUMNS session, idx UNIQUE",
		"DEFINE INDEX IF NOT EXISTS session_project ON TABLE session COLUMNS project",
	}
	for _, statement := range statements {
		if err := Exec(ctx, statement, nil); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
	}
	return nil
}

// recoverJobs marks jobs left "running" by a previous (crashed) process as interrupted.
func recoverJobs(ctx context.Context) error {
	return Exec(ctx, "UPDATE job SET state='interrupted' WHERE state='running'", nil)
}

// Query runs a single-statement SurrealQL query and returns the first statement's rows.
func Query[T any](ctx context.Context, sql string, vars map[string]any) ([]T, error) {
	results, err := surrealdb.Query[[]T](ctx, conn, sql, vars)
	if err != nil {
		return nil, err
	}
	if results == nil || len(*results) == 0 {
		return nil, nil
	}
	first := (*results)[0]
	if first.Status != "" && first.Status != "OK" {
		return nil, fmt.Errorf("query failed: %s", first.Status)
	}
	return first.Result, nil
}

// Exec runs a statement whose result is discarded (DEFINE/UPDATE/DELETE/UPSERT).
func Exec(ctx context.Context, sql string, vars map[string]any) error {
	results, err := surrealdb.Query[any](ctx, conn, sql, vars)
	if err != nil {
		return err
	}
	if results != nil {
		for _, result := range *results {
			if result.Status != "" && result.Status != "OK" {
				return fmt.Errorf("exec failed: %s", result.Status)
			}
		}
	}
	return nil
}

// GetSetting reads a persisted string setting.
func GetSetting(ctx context.Context, key string) (string, bool) {
	type row struct {
		Value string `json:"value"`
	}
	rows, err := Query[row](ctx, "SELECT value FROM type::record('setting', $k)", map[string]any{"k": key})
	if err != nil || len(rows) == 0 {
		return "", false
	}
	return rows[0].Value, true
}

// SetSetting persists a string setting.
func SetSetting(ctx context.Context, key, value string) error {
	return Exec(ctx, "UPSERT type::record('setting', $k) SET value=$v",
		map[string]any{"k": key, "v": value})
}
