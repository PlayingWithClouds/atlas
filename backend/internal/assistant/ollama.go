// Package assistant runs the in-app labeling assistant: a bounded tool-calling loop
// against a local ollama, over the same MCP tools an external client would get.
//
// The assistant reads and proposes. It cannot run a workflow, confirm a label or delete
// anything, because those tools do not exist — see internal/mcp.
package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"atlas/backend/internal/config"
	"atlas/backend/internal/mcp"
)

const (
	defaultURL          = "http://localhost:11434"
	defaultMaxToolCalls = 8
	// A local model on a busy GPU is slow, not broken; the ceiling is here so a wedged
	// ollama fails the turn instead of holding the request open forever.
	replyTimeout = 5 * time.Minute
)

// Settings resolves the configured assistant, filling in the defaults.
func Settings() config.Assistant {
	settings := config.Get().Assistant
	if settings.Backend == "" {
		settings.Backend = BackendOllama
	}
	if settings.URL == "" {
		settings.URL = defaultURL
	}
	if settings.MaxToolCalls <= 0 {
		settings.MaxToolCalls = defaultMaxToolCalls
	}
	settings.Claude = claudeDefaults(settings.Claude)
	return settings
}

// Message is one turn in the conversation, in ollama's shape.
type Message struct {
	Role    string `json:"role"` // system | user | assistant | tool
	Content string `json:"content"`
	// Thinking is the model's reasoning, which a thinking-capable model returns
	// separately from its answer. On a turn that calls a tool it is often the only
	// thing populated — the content is empty because the model's "answer" is the call.
	Thinking  string     `json:"thinking,omitempty"`
	Images    []string   `json:"images,omitempty"`     // base64, for the vision model only
	ToolCalls []ToolCall `json:"tool_calls,omitempty"` // what the model wants to run
	ToolName  string     `json:"tool_name,omitempty"`  // set on tool results
}

// ToolCall is a model's request to run one tool.
type ToolCall struct {
	Function struct {
		Name      string   `json:"name"`
		Arguments mcp.Args `json:"arguments"`
	} `json:"function"`
}

type chatRequest struct {
	Model    string           `json:"model"`
	Messages []Message        `json:"messages"`
	Tools    []map[string]any `json:"tools,omitempty"`
	Stream   bool             `json:"stream"`
	// Think is only sent to models that advertise the capability: ollama rejects it
	// outright for models that do not.
	Think   *bool          `json:"think,omitempty"`
	Options map[string]any `json:"options,omitempty"`
}

type chatResponse struct {
	Message Message `json:"message"`
	Done    bool    `json:"done"`
	Error   string  `json:"error"`
}

// chat sends one turn to ollama and returns the model's reply. Streaming is off: the
// loop needs the whole message to know whether it asked for a tool, and the pane's
// progress comes from the tool events the loop emits rather than from token-by-token
// output.
func chat(ctx context.Context, settings config.Assistant, model string, messages []Message,
	tools []map[string]any) (Message, error) {

	payload := chatRequest{Model: model, Messages: messages, Tools: tools, Stream: false}
	if Thinks(ctx, settings, model) {
		enabled := true
		payload.Think = &enabled
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Message{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, replyTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, settings.URL+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return Message{}, fmt.Errorf("ollama unreachable at %s: %w", settings.URL, err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return Message{}, fmt.Errorf("ollama answered %s", response.Status)
	}
	var decoded chatResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return Message{}, fmt.Errorf("ollama returned an unreadable reply: %w", err)
	}
	if decoded.Error != "" {
		return Message{}, fmt.Errorf("ollama: %s", decoded.Error)
	}
	return decoded.Message, nil
}

// toolDefinitions renders the MCP registry in the shape ollama expects, plus the vision
// tool, which exists only inside this loop.
func toolDefinitions() []map[string]any {
	registry := mcp.Registry()
	definitions := make([]map[string]any, 0, len(registry)+1)
	for _, tool := range registry {
		definitions = append(definitions, functionTool(tool.Name, tool.Description, tool.Schema))
	}
	return append(definitions, functionTool(lookToolName, lookToolDescription, lookToolSchema()))
}

func functionTool(name, description string, schema map[string]any) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name": name, "description": description, "parameters": schema,
		},
	}
}
