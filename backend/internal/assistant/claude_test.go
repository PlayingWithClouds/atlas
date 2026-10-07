package assistant

import (
	"encoding/json"
	"strings"
	"testing"

	"atlas/backend/internal/config"
)

// stream is the CLI's --output-format stream-json for one turn that called a tool,
// thought about the answer and then gave one.
const stream = `
{"type":"system","subtype":"init","session_id":"abc-123","tools":["Bash"]}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"check the session first"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"mcp__atlas__list_entities","input":{"sid":"s1","status":"pending"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"{\"total\":12}"}]}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"12 clips are still pending."}]}}
{"type":"result","subtype":"success","is_error":false,"session_id":"abc-123","result":"12 clips are still pending."}
`

func replay(input string) ([]Event, outcome) {
	var events []Event
	result := readClaudeEvents(strings.NewReader(input), func(event Event) {
		events = append(events, event)
	})
	return events, result
}

func TestReadClaudeEventsTranslatesTheStream(t *testing.T) {
	events, result := replay(stream)

	kinds := make([]string, 0, len(events))
	for _, event := range events {
		kinds = append(kinds, event.Kind)
	}
	want := []string{"session", "thinking", "tool", "tool_result", "message"}
	if strings.Join(kinds, ",") != strings.Join(want, ",") {
		t.Fatalf("kinds = %v, want %v", kinds, want)
	}
	if events[0].Session != "abc-123" {
		t.Fatalf("session = %q, want abc-123", events[0].Session)
	}
	if events[2].Tool != "mcp__atlas__list_entities" {
		t.Fatalf("tool = %q", events[2].Tool)
	}
	if !strings.Contains(events[2].Detail, `"sid":"s1"`) {
		t.Fatalf("tool detail lost its arguments: %q", events[2].Detail)
	}
	// A tool result names only the call it answers, so the loop has to label it from
	// the tool_use it saw go past.
	if events[3].Tool != "mcp__atlas__list_entities" {
		t.Fatalf("tool result = %q, want the call's name", events[3].Tool)
	}
	if !strings.Contains(events[3].Detail, "total") {
		t.Fatalf("tool result detail = %q", events[3].Detail)
	}
	if result.text != "12 clips are still pending." {
		t.Fatalf("answer = %q", result.text)
	}
}

func TestReadClaudeEventsReportsAFailedRun(t *testing.T) {
	failed := `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the tool crashed"}`
	events, result := replay(failed)

	if len(events) != 1 || events[0].Kind != "error" {
		t.Fatalf("events = %+v, want one error", events)
	}
	if events[0].Content != "the tool crashed" {
		t.Fatalf("error = %q", events[0].Content)
	}
	// A failed turn must not also be reported as an answer.
	if result.text != "" {
		t.Fatalf("answer = %q, want none", result.text)
	}
}

// A truncated stream is what a killed CLI leaves behind. Whatever arrived stays useful.
func TestReadClaudeEventsSurvivesATruncatedStream(t *testing.T) {
	truncated := `{"type":"system","subtype":"init","session_id":"abc-123"}
{"type":"assistant","message":{"content":[{"type":"text","text":"partial`
	events, result := replay(truncated)

	if len(events) != 1 || events[0].Session != "abc-123" {
		t.Fatalf("events = %+v, want the session id", events)
	}
	if result.text != "" {
		t.Fatalf("answer = %q, want none", result.text)
	}
}

func TestResultTextFlattensBothShapes(t *testing.T) {
	if text := resultText(json.RawMessage(`"plain"`)); text != "plain" {
		t.Fatalf("string content = %q", text)
	}
	blocks := json.RawMessage(`[{"type":"text","text":"one"},{"type":"text","text":"two"}]`)
	if text := resultText(blocks); text != "one\ntwo" {
		t.Fatalf("block content = %q", text)
	}
	if text := resultText(nil); text != "" {
		t.Fatalf("empty content = %q", text)
	}
}

func TestClaudeArgumentsCarryTheAtlasServerAndSession(t *testing.T) {
	settings := claudeDefaults(config.Claude{Model: "opus", MaxBudgetUSD: 2})
	arguments := claudeArguments(settings, Turn{Session: "abc-123", SID: "s1"})

	joined := strings.Join(arguments, " ")
	for _, expected := range []string{"--print", "--output-format stream-json", "--strict-mcp-config",
		"--setting-sources ", "--resume abc-123", "--model opus", "--max-budget-usd 2"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("arguments missing %q: %v", expected, arguments)
		}
	}

	var decoded struct {
		MCPServers map[string]struct {
			Type string `json:"type"`
			URL  string `json:"url"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(valueAfter(arguments, "--mcp-config")), &decoded); err != nil {
		t.Fatalf("mcp config is not JSON: %v", err)
	}
	server, known := decoded.MCPServers[mcpServerName]
	if !known {
		t.Fatalf("mcp config has no %s server: %+v", mcpServerName, decoded)
	}
	if server.Type != "http" || server.URL != defaultClaudeMCPURL {
		t.Fatalf("server = %+v", server)
	}
}

// The machine's own Claude Code configuration must not reach the atlas assistant: a
// user's hooks and output style would otherwise decide how the pane answers.
func TestClaudeArgumentsIsolateTheUsersConfiguration(t *testing.T) {
	arguments := claudeArguments(claudeDefaults(config.Claude{}), Turn{})
	if valueAfter(arguments, "--setting-sources") != "" {
		t.Fatalf("setting sources = %q, want none", valueAfter(arguments, "--setting-sources"))
	}
	var present bool
	for _, argument := range arguments {
		if argument == "--setting-sources" {
			present = true
		}
	}
	if !present {
		t.Fatalf("arguments do not isolate settings: %v", arguments)
	}
}

// A fresh conversation must not resume anything, or every turn reopens the same one.
func TestClaudeArgumentsOmitResumeWithoutASession(t *testing.T) {
	arguments := claudeArguments(claudeDefaults(config.Claude{}), Turn{})
	if strings.Contains(strings.Join(arguments, " "), "--resume") {
		t.Fatalf("arguments resume without a session: %v", arguments)
	}
}

func TestClaudeDefaultsNeverSkipPermissions(t *testing.T) {
	arguments := claudeArguments(claudeDefaults(config.Claude{}), Turn{})
	for _, argument := range arguments {
		if strings.Contains(argument, "dangerously") || argument == "--permission-mode" {
			t.Fatalf("argument %q bypasses permissions", argument)
		}
	}
}

func TestLatestReadsTheNewestQuestion(t *testing.T) {
	turn := Turn{Messages: []Message{
		{Role: "user", Content: "first"},
		{Role: "assistant", Content: "an answer"},
		{Role: "user", Content: "second"},
	}}
	if latest := turn.Latest(); latest != "second" {
		t.Fatalf("latest = %q, want second", latest)
	}
	if latest := (Turn{}).Latest(); latest != "" {
		t.Fatalf("latest of an empty turn = %q", latest)
	}
}

func valueAfter(arguments []string, flag string) string {
	for index, argument := range arguments {
		if argument == flag && index+1 < len(arguments) {
			return arguments[index+1]
		}
	}
	return ""
}
