// Package api wires the HTTP handlers to the core packages, reproducing the JSON contract
// the SvelteKit frontend expects. Routing uses the stdlib net/http ServeMux (Go 1.22
// method+path patterns); CORS is applied as an outer middleware.
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"atlas/backend/internal/mcp"
	"atlas/backend/internal/registry"
)

const pluginTimeout = 120 * time.Second

// New builds the fully-routed HTTP handler.
func New() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", handleHealth)

	mux.HandleFunc("GET /api/assistant", handleAssistantConfig)
	mux.HandleFunc("POST /api/assistant/chat", handleAssistantChat)

	// The MCP tool surface, for the in-app assistant and for external clients. Both
	// spellings are served: clients differ on whether they add the trailing slash.
	mux.Handle("/api/mcp", mcp.Handler())
	mux.Handle("/api/mcp/", mcp.Handler())

	mux.HandleFunc("GET /api/ws", handleWebSocket)

	mux.HandleFunc("GET /api/plugins", handlePluginsList)
	mux.HandleFunc("POST /api/plugins/reload", handlePluginsReload)

	mux.HandleFunc("GET /api/projects", handleProjectsList)
	mux.HandleFunc("POST /api/projects", handleProjectCreate)
	mux.HandleFunc("GET /api/projects/{id}", handleProjectGet)
	mux.HandleFunc("PUT /api/projects/{id}", handleProjectUpdate)
	mux.HandleFunc("DELETE /api/projects/{id}", handleProjectDelete)

	mux.HandleFunc("GET /api/sources/kinds", handleSourceKinds)
	mux.HandleFunc("GET /api/sources/{kind}/items", handleSourceItems)

	mux.HandleFunc("GET /api/config", handleConfigGet)
	mux.HandleFunc("POST /api/config", handleConfigPost)

	mux.HandleFunc("GET /api/jobs", handleJobsList)
	mux.HandleFunc("GET /api/jobs/{id}", handleJobGet)

	mux.HandleFunc("GET /api/stats", handleStats)

	mux.HandleFunc("POST /api/sessions", handleSessionCreate)
	mux.HandleFunc("GET /api/sessions", handleSessionsList)
	mux.HandleFunc("GET /api/sessions/{sid}", handleSessionGet)
	mux.HandleFunc("DELETE /api/sessions/{sid}", handleSessionDelete)
	mux.HandleFunc("POST /api/sessions/{sid}/opened", handleSessionOpened)
	mux.HandleFunc("POST /api/sessions/{sid}/closed", handleSessionClosed)

	// Label loop
	mux.HandleFunc("GET /api/sessions/{sid}/next", handleNext)
	mux.HandleFunc("GET /api/sessions/{sid}/item/{image_id}", handleItem)
	mux.HandleFunc("GET /api/sessions/{sid}/image/{image_id}", handleImage)
	mux.HandleFunc("POST /api/sessions/{sid}/label", handleLabel)
	mux.HandleFunc("POST /api/sessions/{sid}/skip", handleSkip)
	mux.HandleFunc("GET /api/sessions/{sid}/images", handleImages)
	mux.HandleFunc("DELETE /api/sessions/{sid}/image/{image_id}", handleImageDelete)
	mux.HandleFunc("GET /api/sessions/{sid}/duplicates", handleDuplicates)

	// Video playback for temporal spans (HEAD matches these GET patterns).
	mux.HandleFunc("GET /api/sessions/{sid}/video", handleSessionVideo)
	mux.HandleFunc("GET /api/sessions/{sid}/clip/{image_id}", handleSessionClip)
	mux.HandleFunc("GET /api/sessions/{sid}/poster/{image_id}", handleSessionPoster)
	mux.HandleFunc("GET /api/sessions/{sid}/sheet", handleSessionSheet)
	mux.HandleFunc("GET /api/sessions/{sid}/search", handleSessionSearch)
	mux.HandleFunc("PATCH /api/sessions/{sid}/item/{image_id}/span", handleSpanUpdate)

	// Workflows
	mux.HandleFunc("GET /api/workflows", handleWorkflowsList)
	mux.HandleFunc("GET /api/workflows/nodes", handleWorkflowNodes)
	mux.HandleFunc("POST /api/workflows", handleWorkflowSave)
	mux.HandleFunc("POST /api/workflows/validate", handleWorkflowValidate)
	mux.HandleFunc("POST /api/sessions/{sid}/workflow/dry-run", handleWorkflowDryRun)
	mux.HandleFunc("DELETE /api/workflows/{workflow_id}", handleWorkflowDelete)
	mux.HandleFunc("POST /api/sessions/{sid}/workflow/{workflow_id}", handleRunSessionWorkflow)

	// Notifications
	mux.HandleFunc("GET /api/notifications", handleNotificationsList)
	mux.HandleFunc("POST /api/notifications/clear", handleNotificationsClear)
	mux.HandleFunc("POST /api/notifications/dismiss", handleNotificationDismiss)

	// Class thumbnails (drawn from labeled dataset images)
	mux.HandleFunc("GET /api/classes/thumbnails", handleClassThumbnails)
	mux.HandleFunc("GET /api/classes/{class}/thumb", handleClassThumb)

	// Insights, random, dataset
	mux.HandleFunc("GET /api/insights", handleInsights)
	mux.HandleFunc("GET /api/random/images", handleRandomImages)
	mux.HandleFunc("POST /api/dataset/export", handleDatasetExport)
	mux.HandleFunc("POST /api/dataset/import", handleDatasetImport)

	return withCORS(withAccessLog(mux))
}

// withAccessLog logs one line per request when ATLAS_ACCESS_LOG is set: status, bytes,
// duration, the Range asked for, and whether the client hung up mid-response. Media
// bugs live in that last column — a request that never finishes holds a browser
// connection slot, and nothing else about the response looks wrong.
func withAccessLog(next http.Handler) http.Handler {
	if os.Getenv("ATLAS_ACCESS_LOG") == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The readiness probe polls health every second; logging it buries the traffic
		// the log exists for.
		if r.URL.Path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)

		outcome := "done"
		if r.Context().Err() != nil {
			outcome = "client-gone"
		}
		rangeHeader := r.Header.Get("Range")
		if rangeHeader == "" {
			rangeHeader = "-"
		}
		log.Printf("%s %s -> %d %dB %v range=%s %s",
			r.Method, r.URL.RequestURI(), recorder.status, recorder.written,
			time.Since(started).Round(time.Millisecond), rangeHeader, outcome)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status  int
	written int64
}

func (recorder *statusRecorder) WriteHeader(status int) {
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *statusRecorder) Write(payload []byte) (int, error) {
	written, err := recorder.ResponseWriter.Write(payload)
	recorder.written += int64(written)
	return written, err
}

// The WebSocket handler needs the underlying connection, so the wrapper has to pass
// Hijack through or /api/ws breaks.
func (recorder *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := recorder.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (recorder *statusRecorder) Flush() {
	if flusher, ok := recorder.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]any{"detail": detail})
}

func decodeJSON(r *http.Request, target any) error {
	return json.NewDecoder(r.Body).Decode(target)
}

// pluginCall dispatches an RPC to a plugin and unmarshals the raw result into target.
func pluginCall(ctx context.Context, pluginID, method string, params map[string]any, target any) error {
	raw, err := registry.Default.Call(ctx, pluginID, method, params, pluginTimeout)
	if err != nil {
		return err
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(raw, target)
}
