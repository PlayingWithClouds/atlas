package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"atlas/backend/internal/config"
	"atlas/backend/internal/workspace"
)

// The Claude Code backend does not drive a tool loop. That CLI is already an agent: it
// reaches atlas's own MCP server over HTTP for the data, and writes and runs code in the
// workspace for everything the tools do not cover. Atlas spawns it, translates its event
// stream into pane events, and hands back the answer.
//
// It runs with real shell access inside the workspace — that is the point, since the
// assistant is meant to write scripts and install what they need. The confinement is the
// working directory (<workspace>/code), the single --add-dir, and the allowed-tools list,
// which is configurable. Permissions are never skipped.
const (
	defaultClaudeBinary  = "claude"
	defaultClaudeMCPURL  = "http://127.0.0.1:8123/api/mcp"
	defaultClaudeTimeout = 15 * time.Minute
	// mcpServerName is the prefix its tools appear under: mcp__atlas__list_sessions.
	mcpServerName = "atlas"
)

func defaultClaudeTools() []string {
	return []string{"Bash", "Read", "Write", "Edit", "Glob", "Grep"}
}

func defaultClaudeAllowedTools() []string {
	return []string{"mcp__" + mcpServerName + "__*", "Read", "Glob", "Grep", "Write", "Edit", "Bash"}
}

func claudeDefaults(settings config.Claude) config.Claude {
	if settings.Binary == "" {
		settings.Binary = defaultClaudeBinary
	}
	if settings.MCPURL == "" {
		settings.MCPURL = defaultClaudeMCPURL
	}
	if len(settings.Tools) == 0 {
		settings.Tools = defaultClaudeTools()
	}
	if len(settings.AllowedTools) == 0 {
		settings.AllowedTools = defaultClaudeAllowedTools()
	}
	return settings
}

func claudeTimeout(settings config.Claude) time.Duration {
	if settings.TimeoutSeconds <= 0 {
		return defaultClaudeTimeout
	}
	return time.Duration(settings.TimeoutSeconds) * time.Second
}

// runClaude runs one turn through the CLI. A conversation is resumed by id rather than
// replayed: the CLI owns the transcript, and the pane carries the id between turns.
func runClaude(ctx context.Context, settings config.Assistant, turn Turn, emit func(Event)) []Message {
	directory, err := workingDirectory()
	if err != nil {
		emit(Event{Kind: "error", Content: err.Error()})
		return nil
	}
	prompt := turn.Latest()
	if strings.TrimSpace(prompt) == "" {
		emit(Event{Kind: "error", Content: "there is nothing to answer — the turn carries no user message"})
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, claudeTimeout(settings.Claude))
	defer cancel()

	answer, err := streamClaude(ctx, settings.Claude, directory, prompt, turn, emit)
	// A conversation the CLI no longer knows about — its state cleared, or a session
	// from another machine — fails on --resume alone. Starting fresh beats dead-ending
	// the pane, as long as nothing has been shown yet.
	if err != nil && turn.Session != "" && answer.events == 0 {
		turn.Session = ""
		answer, err = streamClaude(ctx, settings.Claude, directory, prompt, turn, emit)
	}
	if err != nil {
		emit(Event{Kind: "error", Content: err.Error()})
		return nil
	}
	if answer.text == "" {
		return nil
	}
	return []Message{{Role: "assistant", Content: answer.text}}
}

// workingDirectory is where the CLI runs: the workspace's code directory, so anything it
// writes or installs lands with the data it was written against.
func workingDirectory() (string, error) {
	if !workspace.Active() {
		return "", fmt.Errorf("the claude backend needs a workspace — run `atlas init <dir>` and set %s",
			workspace.EnvVar)
	}
	directory := workspace.Code()
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	return directory, nil
}

// outcome is what one CLI run produced: its final answer, and how much it managed to
// report before failing, which decides whether a retry would be visible.
type outcome struct {
	text   string
	events int
}

func streamClaude(ctx context.Context, settings config.Claude, directory, prompt string,
	turn Turn, emit func(Event)) (outcome, error) {

	command := exec.CommandContext(ctx, settings.Binary, claudeArguments(settings, turn)...)
	command.Dir = directory
	command.Stdin = strings.NewReader(prompt)
	command.Env = append(os.Environ(), workspace.EnvVar+"="+workspace.Root())

	stdout, err := command.StdoutPipe()
	if err != nil {
		return outcome{}, err
	}
	var problems bytes.Buffer
	command.Stderr = &problems

	if err := command.Start(); err != nil {
		return outcome{}, fmt.Errorf("cannot run %s: %w", settings.Binary, err)
	}
	result := readClaudeEvents(stdout, emit)
	if err := command.Wait(); err != nil {
		return result, fmt.Errorf("%s failed: %w%s", settings.Binary, err, tail(problems.String()))
	}
	return result, nil
}

// claudeArguments builds the command line. The MCP config is passed inline and marked
// strict, so the CLI sees atlas's tools and no others a developer happens to have
// configured on this machine.
func claudeArguments(settings config.Claude, turn Turn) []string {
	arguments := []string{
		"--print",
		"--output-format", "stream-json",
		"--verbose",
		"--mcp-config", mcpConfig(settings.MCPURL),
		"--strict-mcp-config",
		// The assistant is atlas's, not this machine's user's: without this it inherits
		// their hooks, output styles and memory, and answers as whatever they have
		// configured Claude Code to be.
		"--setting-sources", "",
		"--tools", strings.Join(settings.Tools, ","),
		"--allowedTools", strings.Join(settings.AllowedTools, ","),
		"--add-dir", workspace.Root(),
		"--append-system-prompt", claudeSystemPrompt(turn),
	}
	if settings.Model != "" {
		arguments = append(arguments, "--model", settings.Model)
	}
	if settings.MaxBudgetUSD > 0 {
		arguments = append(arguments, "--max-budget-usd", strconv.FormatFloat(settings.MaxBudgetUSD, 'f', -1, 64))
	}
	if turn.Session != "" {
		arguments = append(arguments, "--resume", turn.Session)
	}
	return arguments
}

func mcpConfig(url string) string {
	encoded, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			mcpServerName: map[string]any{"type": "http", "url": url},
		},
	})
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func claudeSystemPrompt(turn Turn) string {
	var prompt strings.Builder
	prompt.WriteString(`You are the assistant inside atlas, a tool for labeling video clips and images.

The atlas MCP tools read the data: sessions, entities, the taxonomy, classifier insights
and predictions. Use them first. For anything they do not cover — a custom query, a
metric, bounding boxes, calling a model over a narrowed set — write a script and run it.
Your working directory is the workspace's code/ directory; installing what you need there
is expected, and what you write stays for next time.

You propose, a human decides. propose_labels writes proposals a human confirms in the
grid; nothing you do labels, deletes or changes the taxonomy on its own.

Answer in a few sentences: what you found, and what you would do.`)

	if turn.SID != "" {
		prompt.WriteString("\n\nThe user is looking at session " + turn.SID + ".")
	}
	if turn.Project != "" {
		prompt.WriteString(" The project is " + turn.Project + ".")
	}
	if workspace.Active() {
		prompt.WriteString("\nThe workspace is " + workspace.Root() +
			" — its exports/ holds labeled data written out for you, cache/ the vector pools.")
	}
	return prompt.String()
}

// --- the event stream --------------------------------------------------------

// claudeEvent is one line of --output-format stream-json. Only the fields the pane needs
// are decoded; the rest of the CLI's envelope is ignored on purpose, so a new field in a
// later version cannot break the parse.
type claudeEvent struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	Message   struct {
		Content []claudeBlock `json:"content"`
	} `json:"message"`
	Result  string `json:"result"`
	IsError bool   `json:"is_error"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ID        string          `json:"id"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// readClaudeEvents translates the CLI's stream into pane events. Tool results name only
// the call they answer, so the names seen on the way past are what label them.
func readClaudeEvents(stream io.Reader, emit func(Event)) outcome {
	decoder := json.NewDecoder(stream)
	toolNames := map[string]string{}
	announced := ""
	var result outcome

	for {
		var event claudeEvent
		if err := decoder.Decode(&event); err != nil {
			return result
		}
		result.events++
		switch event.Type {
		case "system":
			// Every system event repeats the session id; the pane only needs to hear it
			// when it changes, which is once. It is sent as soon as it is known rather
			// than at the end, so a turn that later fails still leaves a resumable id.
			if event.SessionID != "" && event.SessionID != announced {
				announced = event.SessionID
				emit(Event{Kind: "session", Session: event.SessionID})
			}
		case "assistant":
			emitAssistantBlocks(event.Message.Content, toolNames, emit)
		case "user":
			emitToolResults(event.Message.Content, toolNames, emit)
		case "result":
			result.text = event.Result
			if event.IsError {
				emit(Event{Kind: "error", Content: resultError(event)})
				result.text = ""
			}
		}
	}
}

func emitAssistantBlocks(blocks []claudeBlock, toolNames map[string]string, emit func(Event)) {
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if strings.TrimSpace(block.Text) != "" {
				emit(Event{Kind: "message", Content: block.Text})
			}
		case "thinking":
			if strings.TrimSpace(block.Thinking) != "" {
				emit(Event{Kind: "thinking", Content: block.Thinking})
			}
		case "tool_use":
			toolNames[block.ID] = block.Name
			emit(Event{Kind: "tool", Tool: block.Name, Detail: summarize(string(block.Input))})
		}
	}
}

func emitToolResults(blocks []claudeBlock, toolNames map[string]string, emit func(Event)) {
	for _, block := range blocks {
		if block.Type != "tool_result" {
			continue
		}
		emit(Event{
			Kind:   "tool_result",
			Tool:   toolNames[block.ToolUseID],
			Detail: summarize(resultText(block.Content)),
		})
	}
}

// resultText flattens a tool result, whose content is a bare string on some tools and a
// list of typed blocks on others.
func resultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var blocks []claudeBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return string(raw)
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func resultError(event claudeEvent) string {
	if event.Result != "" {
		return event.Result
	}
	if event.Subtype != "" {
		return "the assistant stopped: " + event.Subtype
	}
	return "the assistant stopped without an answer"
}

// tail keeps the end of a failed run's stderr, which is where the reason is.
func tail(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	const limit = 500
	if len(trimmed) > limit {
		trimmed = "…" + trimmed[len(trimmed)-limit:]
	}
	return ": " + trimmed
}
