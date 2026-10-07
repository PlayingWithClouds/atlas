package api

import (
	"encoding/json"
	"net/http"

	"atlas/backend/internal/assistant"
	"atlas/backend/internal/config"
	"atlas/backend/internal/mcp"
)

// handleAssistantConfig tells the frontend whether the pane should exist, and what the
// assistant can actually do. The tool list comes from the registry rather than from a
// hand-written blurb, so what the pane advertises cannot drift from what it can run.
func handleAssistantConfig(w http.ResponseWriter, r *http.Request) {
	settings := assistant.Settings()
	tools := make([]map[string]string, 0)
	for _, tool := range mcp.Registry() {
		tools = append(tools, map[string]string{"name": tool.Name, "description": tool.Description})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": settings.Enabled,
		"backend": settings.Backend,
		"model":   modelName(settings),
		"vision":  settings.VisionModel != "",
		"tools":   tools,
	})
}

// modelName reports the model the pane should name. Each backend keeps its own, and the
// Claude Code backend may name none at all, which means whatever that CLI defaults to.
func modelName(settings config.Assistant) string {
	if settings.Backend != assistant.BackendClaude {
		return settings.Model
	}
	if settings.Claude.Model == "" {
		return "claude code"
	}
	return settings.Claude.Model
}

// handleAssistantChat runs one turn and streams what happens as server-sent events.
// SSE rather than the app's websocket: this is one client's private conversation, not
// shared state, and it arrives as the answer to the request that started it.
func handleAssistantChat(w http.ResponseWriter, r *http.Request) {
	if !assistant.Settings().Enabled {
		writeError(w, http.StatusNotFound, "the assistant is not enabled in atlas.config.json")
		return
	}
	var turn assistant.Turn
	if err := decodeJSON(r, &turn); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	flusher, streaming := w.(http.Flusher)
	if !streaming {
		writeError(w, http.StatusInternalServerError, "this connection cannot stream")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	send := func(event assistant.Event) {
		encoded, err := json.Marshal(event)
		if err != nil {
			return
		}
		_, _ = w.Write([]byte("data: "))
		_, _ = w.Write(encoded)
		_, _ = w.Write([]byte("\n\n"))
		flusher.Flush()
	}

	messages := assistant.Run(r.Context(), turn, send)
	// The transcript comes back at the end so the next turn carries the tool results;
	// without them the model re-runs the same reads every message.
	final, err := json.Marshal(messages)
	if err != nil {
		final = []byte("[]")
	}
	send(assistant.Event{Kind: "done", Content: string(final)})
}
