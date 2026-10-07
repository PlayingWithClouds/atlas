package mcp

import (
	"encoding/json"
	"fmt"

	"atlas/backend/internal/config"
)

// Args are a tool call's arguments as they arrive over the wire. Models are loose with
// types — an integer can turn up as a float, a string, or nothing at all — so every
// reader here coerces rather than asserts, and falls back instead of failing.
type Args map[string]any

func (a Args) String(key string) string {
	value, ok := a[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprintf("%v", value)
}

func (a Args) Int(key string, fallback int) int {
	switch typed := a[key].(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		var parsed int
		if _, err := fmt.Sscanf(typed, "%d", &parsed); err == nil {
			return parsed
		}
	}
	return fallback
}

func (a Args) List(key string) []map[string]any {
	raw, ok := a[key].([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		if item, ok := entry.(map[string]any); ok {
			out = append(out, item)
		}
	}
	return out
}

func (a Args) Strings(key string) []string {
	raw, ok := a[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		out = append(out, fmt.Sprintf("%v", entry))
	}
	return out
}

// Graph decodes a workflow graph argument. It round-trips through JSON rather than
// picking the map apart by hand, so the graph a tool receives is exactly the shape the
// executor and the designer already agree on.
func (a Args) Graph(key string) (*config.WorkflowGraph, error) {
	raw, present := a[key]
	if !present || raw == nil {
		return nil, fmt.Errorf("%s is required", key)
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("%s is not a graph: %w", key, err)
	}
	var graph config.WorkflowGraph
	if err := json.Unmarshal(encoded, &graph); err != nil {
		return nil, fmt.Errorf("%s is not a graph: %w", key, err)
	}
	return &graph, nil
}
