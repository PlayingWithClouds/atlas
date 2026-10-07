package mcp

import (
	"encoding/json"
	"net/http"

	"atlas/backend/internal/config"
)

// The protocol version this server speaks. A client asking for a different one still
// gets an answer — the handshake reports what the server supports and clients negotiate
// down — but this is what the tool surface is written against.
const protocolVersion = "2025-06-18"

// Handler serves MCP over JSON-RPC 2.0. Requests are POSTed and answered with plain
// JSON: this server never initiates anything, so the SSE channel a fuller transport
// would open has nothing to carry, and GET says so.
//
// It switches on the method itself rather than delegating to a nested mux, which would
// redirect the endpoint's own path to "/" and turn every POST into a 307.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "this MCP server is request/response only; POST JSON-RPC here",
				http.StatusMethodNotAllowed)
			return
		}
		handleRPC(w, r)
	})
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInternal       = -32603
)

func handleRPC(w http.ResponseWriter, r *http.Request) {
	var request rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: codeParse, Message: "malformed JSON-RPC request"}})
		return
	}
	if request.JSONRPC != "2.0" {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: request.ID,
			Error: &rpcError{Code: codeInvalidRequest, Message: "expected jsonrpc 2.0"}})
		return
	}

	// Notifications carry no id and expect no body — the initialized handshake is one.
	if len(request.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	result, rpcErr := dispatch(r, request)
	if rpcErr != nil {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: rpcErr})
		return
	}
	writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: request.ID, Result: result})
}

func dispatch(r *http.Request, request rpcRequest) (any, *rpcError) {
	switch request.Method {
	case "initialize":
		return initializeResult(), nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": describeTools()}, nil
	case "tools/call":
		return callTool(r, request.Params)
	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: "unsupported method " + request.Method}
	}
}

func initializeResult() map[string]any {
	return map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "atlas", "title": config.Get().Title, "version": "0.1.0"},
		"instructions": "Atlas labels video clips and images. Read the session, its classes and its " +
			"insights before suggesting anything. You can propose labels and save workflow drafts; you " +
			"cannot run a workflow, confirm a label, delete an entity or change the taxonomy — a human does that.",
	}
}

func describeTools() []map[string]any {
	tools := Registry()
	described := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		described = append(described, map[string]any{
			"name": tool.Name, "description": tool.Description, "inputSchema": tool.Schema,
		})
	}
	return described
}

func callTool(r *http.Request, params json.RawMessage) (any, *rpcError) {
	var call struct {
		Name      string `json:"name"`
		Arguments Args   `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return nil, &rpcError{Code: codeInvalidRequest, Message: "malformed tools/call params"}
	}

	result, err := Call(r.Context(), call.Name, call.Arguments)
	if err != nil {
		// A failed tool is reported in-band, as content with isError set: the model has
		// to see what went wrong to correct itself, which a transport-level error hides.
		return map[string]any{
			"content": []map[string]any{{"type": "text", "text": err.Error()}},
			"isError": true,
		}, nil
	}
	return map[string]any{"content": contentOf(result), "isError": false}, nil
}

func contentOf(result Result) []map[string]any {
	content := []map[string]any{}
	if result.Data != nil {
		encoded, err := json.Marshal(result.Data)
		if err != nil {
			encoded = []byte(`{"error":"result could not be encoded"}`)
		}
		content = append(content, map[string]any{"type": "text", "text": string(encoded)})
	}
	if result.Image != nil {
		content = append(content, map[string]any{
			"type": "image", "data": result.Image.Base64, "mimeType": result.Image.MIME,
		})
	}
	return content
}

func writeRPC(w http.ResponseWriter, response rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}
