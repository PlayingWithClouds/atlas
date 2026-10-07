// Package rpc is a minimal JSON-RPC 2.0 client over HTTP — the plugin bus transport.
//
// Every plugin exposes one endpoint, POST {url}/rpc, taking
//
//	{"jsonrpc":"2.0","method":"...","params":{...},"id":n}
//
// and replying with a `result` or an `error`.
package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

var counter atomic.Int64

// Error is a JSON-RPC error reply (the plugin is up, the call failed).
type Error struct {
	Code    int
	Message string
	Data    any
}

func (e *Error) Error() string { return e.Message }

type request struct {
	JSONRPC string         `json:"jsonrpc"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
	ID      int64          `json:"id"`
}

type response struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    any    `json:"data"`
	} `json:"error"`
}

// Call invokes a plugin method, returning its raw `result` or an error. A *rpc.Error
// signals a plugin-level failure (transport was fine); any other error is a transport
// failure.
func Call(ctx context.Context, url, method string, params map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}
	body, err := json.Marshal(request{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
		ID:      counter.Add(1),
	})
	if err != nil {
		return nil, err
	}

	endpoint := strings.TrimRight(url, "/") + "/rpc"
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	httpRequest, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")

	httpResponse, err := http.DefaultClient.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer httpResponse.Body.Close()

	var parsed response
	if err := json.NewDecoder(httpResponse.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode rpc response: %w", err)
	}
	if parsed.Error != nil {
		return nil, &Error{Code: parsed.Error.Code, Message: parsed.Error.Message, Data: parsed.Error.Data}
	}
	return parsed.Result, nil
}
