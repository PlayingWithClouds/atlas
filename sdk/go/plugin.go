// Package pluginsdk — Atlas plugin SDK (Go): write a plugin as a JSON-RPC 2.0 HTTP service.
//
// A plugin exposes a single POST /rpc endpoint. This helper handles the envelope + the
// mandatory `capabilities()` handshake, so a plugin is just a set of methods plus its
// declared capabilities:
//
//	plugin := pluginsdk.New("fs")
//	plugin.Declare("source", map[string]any{"kinds": []string{"directory"}, "browsable": false})
//	plugin.Method("source.resolve", func(params pluginsdk.Params) (any, error) { ... })
//	plugin.Serve(9102)
//
// Methods receive the RPC `params` as a map and return a JSON-serializable result.
// Returning an error becomes a JSON-RPC error reply.
//
// Wire-compatible peer of the TypeScript SDK in `sdk/ts` and the Python SDK in `sdk/python`.
package pluginsdk

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

type Params map[string]any

type Handler func(params Params) (any, error)

type rpcRequest struct {
	ID     any    `json:"id"`
	Method string `json:"method"`
	Params Params `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type Plugin struct {
	name         string
	methods      map[string]Handler
	capabilities []map[string]any
}

func New(name string) *Plugin {
	return &Plugin{
		name:    name,
		methods: map[string]Handler{},
	}
}

// Declare advertises a capability (name + arbitrary descriptor fields).
func (p *Plugin) Declare(capability string, info map[string]any) {
	descriptor := map[string]any{"name": capability}
	for key, value := range info {
		descriptor[key] = value
	}
	p.capabilities = append(p.capabilities, descriptor)
}

// Method registers a handler for an RPC method name.
func (p *Plugin) Method(rpcName string, handler Handler) {
	p.methods[rpcName] = handler
}

func (p *Plugin) handle(request rpcRequest) rpcResponse {
	if request.Method == "capabilities" {
		result := map[string]any{"plugin": p.name, "capabilities": p.capabilities}
		return rpcResponse{JSONRPC: "2.0", ID: request.ID, Result: result}
	}

	handler, found := p.methods[request.Method]
	if !found {
		message := fmt.Sprintf("method not found: %s", request.Method)
		return rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: &rpcError{Code: -32601, Message: message}}
	}

	result, err := handler(request.Params)
	if err != nil {
		return rpcResponse{JSONRPC: "2.0", ID: request.ID, Error: &rpcError{Code: -32000, Message: err.Error()}}
	}
	return rpcResponse{JSONRPC: "2.0", ID: request.ID, Result: result}
}

// Handler returns the plugin's http.Handler (POST /rpc + GET /health), for tests
// or embedding into an existing server.
func (p *Plugin) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"ok": true, "plugin": p.name})
	})

	mux.HandleFunc("POST /rpc", func(writer http.ResponseWriter, request *http.Request) {
		var body rpcRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			parseError := rpcResponse{JSONRPC: "2.0", ID: nil, Error: &rpcError{Code: -32700, Message: "parse error"}}
			writeJSON(writer, http.StatusBadRequest, parseError)
			return
		}
		writeJSON(writer, http.StatusOK, p.handle(body))
	})

	return mux
}

// Serve starts the HTTP server and blocks.
func (p *Plugin) Serve(port int) error {
	log.Printf("[%s] plugin listening on :%d", p.name, port)
	return http.ListenAndServe(fmt.Sprintf(":%d", port), p.Handler())
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(payload); err != nil {
		log.Printf("write response: %v", err)
	}
}
