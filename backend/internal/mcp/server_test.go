package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// call posts one JSON-RPC request and returns the decoded response.
func call(t *testing.T, body string) map[string]any {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK && recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() == 0 {
		return nil
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("undecodable response %q: %v", recorder.Body.String(), err)
	}
	return response
}

func resultOf(t *testing.T, response map[string]any) map[string]any {
	t.Helper()
	if problem, failed := response["error"]; failed {
		t.Fatalf("rpc error: %v", problem)
	}
	result, ok := response["result"].(map[string]any)
	if !ok {
		t.Fatalf("result missing from %v", response)
	}
	return result
}

func TestInitializeReportsToolCapability(t *testing.T) {
	result := resultOf(t, call(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	if result["protocolVersion"] != protocolVersion {
		t.Fatalf("protocolVersion = %v", result["protocolVersion"])
	}
	capabilities, ok := result["capabilities"].(map[string]any)
	if !ok || capabilities["tools"] == nil {
		t.Fatalf("capabilities = %v", result["capabilities"])
	}
	if result["instructions"] == nil {
		t.Fatal("a client with no instructions has to guess what atlas is")
	}
}

func TestNotificationsGetNoBody(t *testing.T) {
	// An id-less request is a notification: answering one is a protocol error.
	if response := call(t, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); response != nil {
		t.Fatalf("expected no body, got %v", response)
	}
}

func TestToolsListDescribesEverySchema(t *testing.T) {
	result := resultOf(t, call(t, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	tools, ok := result["tools"].([]any)
	if !ok || len(tools) == 0 {
		t.Fatalf("tools = %v", result["tools"])
	}
	for _, entry := range tools {
		tool := entry.(map[string]any)
		if tool["name"] == "" || tool["description"] == "" {
			t.Fatalf("undescribed tool: %v", tool)
		}
		schema, ok := tool["inputSchema"].(map[string]any)
		if !ok || schema["type"] != "object" {
			t.Fatalf("tool %v has no object schema: %v", tool["name"], tool["inputSchema"])
		}
		if _, listed := schema["required"]; !listed {
			t.Fatalf("tool %v does not say which params are required", tool["name"])
		}
	}
}

func TestToolSurfaceIsReadAndProposeOnly(t *testing.T) {
	// The guarantee is structural: a tool that is not listed cannot be talked into
	// firing, so anything that acts without a human must simply not exist here. This
	// is an exact set on purpose — adding a tool should have to be a deliberate edit
	// to this list, with the question "can this act on its own?" asked out loud.
	allowed := map[string]bool{
		"contact_sheet":       true,
		"dry_run_workflow":    true,
		"get_insights":        true,
		"get_session":         true,
		"list_classes":        true,
		"list_entities":       true,
		"list_node_types":     true,
		"list_sessions":       true,
		"list_workflows":      true,
		"preview_predictions": true,
		"propose_labels":      true, // writes proposals only; a human confirms them
		"save_workflow":       true, // saves a manual draft; never auto-triggered
		"validate_workflow":   true,
	}
	for _, tool := range Registry() {
		if !allowed[tool.Name] {
			t.Fatalf("tool %q is not in the read-and-propose set — can it act without a human?", tool.Name)
		}
		delete(allowed, tool.Name)
	}
	for name := range allowed {
		t.Fatalf("tool %q went missing from the registry", name)
	}
}

func TestUnknownToolIsReportedToTheModel(t *testing.T) {
	// In-band, not as a transport error: the model has to see it to correct itself.
	result := resultOf(t, call(t,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"teleport","arguments":{}}}`))
	if result["isError"] != true {
		t.Fatalf("result = %v", result)
	}
	content := result["content"].([]any)
	text := content[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "unknown tool") {
		t.Fatalf("text = %q", text)
	}
}

func TestMissingArgumentIsReportedToTheModel(t *testing.T) {
	result := resultOf(t, call(t,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_session","arguments":{}}}`))
	if result["isError"] != true {
		t.Fatalf("result = %v", result)
	}
}

func TestUnsupportedMethod(t *testing.T) {
	response := call(t, `{"jsonrpc":"2.0","id":5,"method":"resources/list"}`)
	problem, failed := response["error"].(map[string]any)
	if !failed || problem["code"].(float64) != codeMethodNotFound {
		t.Fatalf("response = %v", response)
	}
}

func TestMalformedRequests(t *testing.T) {
	recorder := httptest.NewRecorder()
	Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{oh no")))
	if !strings.Contains(recorder.Body.String(), "malformed") {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	response := call(t, `{"jsonrpc":"1.0","id":6,"method":"tools/list"}`)
	if _, failed := response["error"]; !failed {
		t.Fatalf("a non-2.0 request should be rejected: %v", response)
	}
}

func TestGetIsRefusedWithAnExplanation(t *testing.T) {
	recorder := httptest.NewRecorder()
	Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestValidateWorkflowToolRunsWithoutADatabase(t *testing.T) {
	// Graph checking is pure, so it is the one tool that can be exercised end to end
	// here — and it is the one an authoring model leans on hardest.
	body := `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"validate_workflow",
		"arguments":{"graph":{"nodes":[{"id":"a","type":"teleport"}],"edges":[]}}}}`
	result := resultOf(t, call(t, body))
	if result["isError"] != false {
		t.Fatalf("a graph with a bad node is a report, not a tool failure: %v", result)
	}
	content := result["content"].([]any)
	text := content[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "unknown node type") {
		t.Fatalf("text = %q", text)
	}
}

func TestArgsCoerceLooseTypes(t *testing.T) {
	args := Args{"count": float64(12), "name": 7, "labels": []any{"a", "b"}}
	if args.Int("count", 0) != 12 {
		t.Fatalf("float argument = %d", args.Int("count", 0))
	}
	if args.Int("missing", 5) != 5 {
		t.Fatal("missing argument should fall back")
	}
	if args.String("name") != "7" {
		t.Fatalf("non-string argument = %q", args.String("name"))
	}
	if labels := args.Strings("labels"); len(labels) != 2 || labels[1] != "b" {
		t.Fatalf("labels = %v", labels)
	}
	if _, err := args.Graph("graph"); err == nil {
		t.Fatal("a missing graph must be an error, not an empty graph")
	}
}
