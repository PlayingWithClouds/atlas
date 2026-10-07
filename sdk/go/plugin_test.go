package pluginsdk

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func callRPC(t *testing.T, plugin *Plugin, body string) rpcResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/rpc", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	plugin.Handler().ServeHTTP(recorder, request)

	var response rpcResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response
}

func TestCapabilitiesHandshake(t *testing.T) {
	plugin := New("demo")
	plugin.Declare("source", map[string]any{"kinds": []string{"directory"}, "browsable": false})

	response := callRPC(t, plugin, `{"jsonrpc":"2.0","id":1,"method":"capabilities"}`)
	if response.Error != nil {
		t.Fatalf("unexpected error: %+v", response.Error)
	}
	result := response.Result.(map[string]any)
	if result["plugin"] != "demo" {
		t.Fatalf("plugin name = %v", result["plugin"])
	}
	capabilities := result["capabilities"].([]any)
	first := capabilities[0].(map[string]any)
	if first["name"] != "source" || first["browsable"] != false {
		t.Fatalf("capability = %v", first)
	}
}

func TestMethodDispatchAndParams(t *testing.T) {
	plugin := New("demo")
	plugin.Method("echo", func(params Params) (any, error) {
		return map[string]any{"got": params["value"]}, nil
	})

	response := callRPC(t, plugin, `{"jsonrpc":"2.0","id":7,"method":"echo","params":{"value":"hi"}}`)
	result := response.Result.(map[string]any)
	if result["got"] != "hi" {
		t.Fatalf("result = %v", result)
	}
	if response.ID != float64(7) {
		t.Fatalf("id = %v", response.ID)
	}
}

func TestMethodNotFound(t *testing.T) {
	response := callRPC(t, New("demo"), `{"jsonrpc":"2.0","id":1,"method":"nope"}`)
	if response.Error == nil || response.Error.Code != -32601 {
		t.Fatalf("expected -32601, got %+v", response.Error)
	}
}

func TestHandlerError(t *testing.T) {
	plugin := New("demo")
	plugin.Method("fail", func(Params) (any, error) {
		return nil, errors.New("boom")
	})

	response := callRPC(t, plugin, `{"jsonrpc":"2.0","id":1,"method":"fail"}`)
	if response.Error == nil || response.Error.Code != -32000 || response.Error.Message != "boom" {
		t.Fatalf("expected -32000 boom, got %+v", response.Error)
	}
}

func TestParseError(t *testing.T) {
	response := callRPC(t, New("demo"), `{not json`)
	if response.Error == nil || response.Error.Code != -32700 {
		t.Fatalf("expected -32700, got %+v", response.Error)
	}
}
