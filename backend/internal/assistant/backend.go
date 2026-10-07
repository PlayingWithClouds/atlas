package assistant

import "context"

// Backends. Ollama drives a bounded tool loop against a local model from inside atlas;
// Claude hands the whole turn to the Claude Code CLI, which is already an agent — it
// calls atlas's MCP server and writes and runs code in the workspace.
const (
	BackendOllama = "ollama"
	BackendClaude = "claude"
)

// Event is one thing worth telling the pane about while a turn runs.
type Event struct {
	Kind    string `json:"kind"` // tool | tool_result | thinking | message | error | done
	Tool    string `json:"tool,omitempty"`
	Detail  string `json:"detail,omitempty"`
	Content string `json:"content,omitempty"`
	// Session is the backend's own conversation id, returned so the pane can send it
	// back on the next turn. Keeping it client-side means atlas stores no conversation
	// state and a backend restart does not orphan one.
	Session string `json:"session,omitempty"`
}

// Turn is one request from the pane: the conversation so far plus what it is about.
type Turn struct {
	Messages []Message `json:"messages"`
	Project  string    `json:"project"`
	SID      string    `json:"sid"`
	// Session resumes a Claude Code conversation. Empty starts a new one; the ollama
	// backend ignores it and replays Messages instead.
	Session string `json:"session"`
}

// Latest returns the newest user message, which is what a backend that keeps its own
// transcript needs — the rest of Messages is history it already has.
func (t Turn) Latest() string {
	for index := len(t.Messages) - 1; index >= 0; index-- {
		if t.Messages[index].Role == "user" {
			return t.Messages[index].Content
		}
	}
	return ""
}

// Run drives one turn on the configured backend, emitting events as it goes and
// returning the messages to append to the transcript.
func Run(ctx context.Context, turn Turn, emit func(Event)) []Message {
	settings := Settings()
	if settings.Backend == BackendClaude {
		return runClaude(ctx, settings, turn, emit)
	}
	return runOllama(ctx, turn, emit)
}
