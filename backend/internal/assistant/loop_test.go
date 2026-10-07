package assistant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"atlas/backend/internal/config"
)

// stubOllama answers each /api/chat request with the next scripted reply, and records
// what it was asked. /api/show answers the capability probe.
type stubOllama struct {
	replies      []Message
	requests     []chatRequest
	capabilities []string
	server       *httptest.Server
}

func newStub(t *testing.T, replies ...Message) *stubOllama {
	t.Helper()
	stub := &stubOllama{replies: replies, capabilities: []string{"completion", "tools"}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/show", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"capabilities": stub.capabilities})
	})
	mux.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
		var request chatRequest
		_ = json.NewDecoder(r.Body).Decode(&request)
		stub.requests = append(stub.requests, request)

		reply := Message{Role: "assistant", Content: "(no script left)"}
		if len(stub.replies) > 0 {
			reply, stub.replies = stub.replies[0], stub.replies[1:]
		}
		_ = json.NewEncoder(w).Encode(chatResponse{Message: reply, Done: true})
	})
	stub.server = httptest.NewServer(mux)
	t.Cleanup(stub.server.Close)
	// Capabilities are cached per model for the process, so each test starts clean.
	t.Cleanup(func() {
		capabilityCache.Lock()
		capabilityCache.byModel = map[string][]string{}
		capabilityCache.Unlock()
	})
	return stub
}

// settingsFor points the package at the stub. The loop reads config.Get(), so the test
// writes the block it would have found there.
func settingsFor(t *testing.T, stub *stubOllama, maxCalls int) {
	t.Helper()
	config.Get().Assistant = config.Assistant{
		Enabled: true, URL: stub.server.URL, Model: "test-model",
		VisionModel: "test-vision", MaxToolCalls: maxCalls,
	}
	t.Cleanup(func() { config.Get().Assistant = config.Assistant{} })
}

func toolCall(name string, args map[string]any) Message {
	call := ToolCall{}
	call.Function.Name = name
	call.Function.Arguments = args
	return Message{Role: "assistant", ToolCalls: []ToolCall{call}}
}

func collect(events *[]Event) func(Event) {
	return func(event Event) { *events = append(*events, event) }
}

func kinds(events []Event) []string {
	out := make([]string, len(events))
	for i, event := range events {
		out[i] = event.Kind
	}
	return out
}

func TestPlainAnswerNeedsNoTools(t *testing.T) {
	stub := newStub(t, Message{Role: "assistant", Content: "Label the uncertain clips first."})
	settingsFor(t, stub, 8)

	var events []Event
	produced := Run(context.Background(), Turn{Messages: []Message{{Role: "user", Content: "what next?"}}}, collect(&events))

	if len(events) != 1 || events[0].Kind != "message" {
		t.Fatalf("events = %v", kinds(events))
	}
	if events[0].Content != "Label the uncertain clips first." {
		t.Fatalf("content = %q", events[0].Content)
	}
	if len(produced) != 1 {
		t.Fatalf("produced %d messages, want the reply only", len(produced))
	}
}

func TestToolCallResultFlowsBackIntoTheConversation(t *testing.T) {
	stub := newStub(t,
		toolCall("validate_workflow", map[string]any{
			"graph": map[string]any{"nodes": []any{map[string]any{"id": "a", "type": "teleport"}}},
		}),
		Message{Role: "assistant", Content: "That node type does not exist."},
	)
	settingsFor(t, stub, 8)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	if got := strings.Join(kinds(events), ","); got != "tool,tool_result,message" {
		t.Fatalf("events = %s", got)
	}
	if !strings.Contains(events[1].Detail, "unknown node type") {
		t.Fatalf("tool result = %q", events[1].Detail)
	}
	// The second request must carry the tool result, or the model answers blind.
	if len(stub.requests) != 2 {
		t.Fatalf("ollama was called %d times", len(stub.requests))
	}
	last := stub.requests[1].Messages
	if last[len(last)-1].Role != "tool" {
		t.Fatalf("final message role = %q", last[len(last)-1].Role)
	}
}

func TestToolFailureIsHandedBackToTheModel(t *testing.T) {
	// A tool that errors must not end the turn: the model has to see the failure to
	// try something else.
	stub := newStub(t,
		toolCall("teleport", map[string]any{}),
		Message{Role: "assistant", Content: "No such tool — I will read the session instead."},
	)
	settingsFor(t, stub, 8)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	if got := strings.Join(kinds(events), ","); got != "tool,tool_result,message" {
		t.Fatalf("events = %s", got)
	}
	if !strings.Contains(events[1].Detail, "unknown tool") {
		t.Fatalf("tool result = %q", events[1].Detail)
	}
}

func TestLoopingIsBounded(t *testing.T) {
	// A model that keeps calling a tool it misunderstands would otherwise never stop.
	stub := newStub(t,
		toolCall("list_workflows", map[string]any{}),
		toolCall("list_workflows", map[string]any{}),
		toolCall("list_workflows", map[string]any{}),
	)
	settingsFor(t, stub, 2)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	last := events[len(events)-1]
	if last.Kind != "error" || !strings.Contains(last.Content, "may be looping") {
		t.Fatalf("last event = %+v", last)
	}
	if len(stub.requests) != 2 {
		t.Fatalf("ollama was called %d times, want the 2 the ceiling allows", len(stub.requests))
	}
}

func TestThinkingIsOnlyRequestedFromModelsThatSupportIt(t *testing.T) {
	stub := newStub(t, Message{Role: "assistant", Content: "done"})
	settingsFor(t, stub, 8)
	// Sending `think` to a model without the capability makes ollama reject the request.
	Run(context.Background(), Turn{}, func(Event) {})
	if stub.requests[0].Think != nil {
		t.Fatal("think must not be sent to a model that does not advertise it")
	}

	// The probe result is cached per model, and both halves use the same model name.
	capabilityCache.Lock()
	capabilityCache.byModel = map[string][]string{}
	capabilityCache.Unlock()

	stub = newStub(t, Message{Role: "assistant", Content: "done"})
	stub.capabilities = []string{"completion", "tools", "thinking"}
	settingsFor(t, stub, 8)
	Run(context.Background(), Turn{}, func(Event) {})
	if stub.requests[0].Think == nil || !*stub.requests[0].Think {
		t.Fatal("think should be sent to a thinking-capable model")
	}
}

func TestThinkingIsSurfacedAndKeptOnlyOnToolTurns(t *testing.T) {
	// Gemma's guidance: previous turns' reasoning is dropped, except where it explains
	// a tool call to the turn that reads the result.
	toolTurn := toolCall("list_workflows", map[string]any{})
	toolTurn.Thinking = "I should look at the saved workflows first."
	stub := newStub(t, toolTurn, Message{Role: "assistant", Content: "There are none.",
		Thinking: "Nothing came back, so I will say so."})
	stub.capabilities = []string{"completion", "tools", "thinking"}
	settingsFor(t, stub, 8)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	if got := strings.Join(kinds(events), ","); got != "thinking,tool,tool_result,thinking,message" {
		t.Fatalf("events = %s", got)
	}

	replayed := stub.requests[1].Messages
	var assistantTurns []Message
	for _, message := range replayed {
		if message.Role == "assistant" {
			assistantTurns = append(assistantTurns, message)
		}
	}
	if len(assistantTurns) != 1 || assistantTurns[0].Thinking == "" {
		t.Fatalf("a tool turn should keep its reasoning: %+v", assistantTurns)
	}
}

func TestReasoningWithoutAnAnswerSaysSo(t *testing.T) {
	stub := newStub(t, Message{Role: "assistant", Content: "", Thinking: "hmm, well, hmm"})
	stub.capabilities = []string{"completion", "tools", "thinking"}
	settingsFor(t, stub, 8)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	last := events[len(events)-1]
	if last.Kind != "error" || !strings.Contains(last.Content, "never wrote an answer") {
		t.Fatalf("last event = %+v", last)
	}
}

func TestAnEmptyReplyIsReportedRatherThanRendered(t *testing.T) {
	// Local models sometimes answer with nothing at all. An empty assistant bubble
	// reads as the app breaking rather than as the model having said nothing.
	stub := newStub(t, Message{Role: "assistant", Content: "   "})
	settingsFor(t, stub, 8)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	if len(events) != 1 || events[0].Kind != "error" {
		t.Fatalf("events = %v", kinds(events))
	}
	if !strings.Contains(events[0].Content, "empty answer") {
		t.Fatalf("content = %q", events[0].Content)
	}
}

func TestUnreachableOllamaEndsTheTurnWithAMessage(t *testing.T) {
	stub := newStub(t)
	settingsFor(t, stub, 8)
	config.Get().Assistant.URL = "http://127.0.0.1:1" // nothing listens here

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	if len(events) != 1 || events[0].Kind != "error" {
		t.Fatalf("events = %v", kinds(events))
	}
	if !strings.Contains(events[0].Content, "ollama unreachable") {
		t.Fatalf("content = %q", events[0].Content)
	}
}

func TestSessionContextIsFilledInForTheModel(t *testing.T) {
	// Small models leave the session out constantly; the pane knows which one is open.
	args := map[string]any{}
	fillContext(args, Turn{SID: "abc123", Project: "clips"})
	if args["sid"] != "abc123" || args["project"] != "clips" {
		t.Fatalf("args = %v", args)
	}

	// What the model did say wins: it may well be asking about another session.
	args = map[string]any{"sid": "other"}
	fillContext(args, Turn{SID: "abc123"})
	if args["sid"] != "other" {
		t.Fatalf("context overwrote the model's own argument: %v", args)
	}
}

func TestAToolThatPanicsDoesNotTakeDownTheTurn(t *testing.T) {
	// Tools are reached with arguments a model invented. list_entities needs a database
	// this test does not have, which is exactly the kind of failure that must stay
	// inside the turn.
	stub := newStub(t,
		toolCall("list_entities", map[string]any{"sid": "nope"}),
		Message{Role: "assistant", Content: "I could not read that session."},
	)
	settingsFor(t, stub, 8)

	var events []Event
	Run(context.Background(), Turn{}, collect(&events))

	if got := strings.Join(kinds(events), ","); got != "tool,tool_result,message" {
		t.Fatalf("events = %s", got)
	}
	if !strings.Contains(events[1].Detail, "error:") {
		t.Fatalf("tool result = %q", events[1].Detail)
	}
}

func TestSystemPromptStatesTheLimits(t *testing.T) {
	prompt := systemPrompt(Turn{SID: "abc123", Project: "clips"})
	for _, phrase := range []string{"cannot label", "abc123", "clips", lookToolName, "dry_run_workflow"} {
		if !strings.Contains(prompt, phrase) {
			t.Fatalf("prompt does not mention %q", phrase)
		}
	}
}

func TestToolDefinitionsIncludeVision(t *testing.T) {
	definitions := toolDefinitions()
	names := map[string]bool{}
	for _, definition := range definitions {
		function := definition["function"].(map[string]any)
		names[function["name"].(string)] = true
		if function["parameters"] == nil {
			t.Fatalf("tool %v has no parameter schema", function["name"])
		}
	}
	if !names[lookToolName] {
		t.Fatal("the vision tool is missing")
	}
	if !names["dry_run_workflow"] {
		t.Fatal("the MCP registry is missing from the tool definitions")
	}
}

func TestVisionNeedsAModel(t *testing.T) {
	stub := newStub(t)
	settingsFor(t, stub, 8)
	config.Get().Assistant.VisionModel = ""

	if _, err := look(context.Background(), Settings(), map[string]any{"sid": "abc"}); err == nil {
		t.Fatal("looking without a vision model must say so")
	}
}
