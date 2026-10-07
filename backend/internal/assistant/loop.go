package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"atlas/backend/internal/config"
	"atlas/backend/internal/mcp"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sheet"
)

// runOllama drives one turn to completion against a local model, emitting events as it
// goes. It returns the messages to append to the transcript so the next turn carries the
// tool results.
//
// Tool calls are bounded: a small local model that loops on a tool it misunderstands
// would otherwise never stop, and the ceiling turns that into a visible answer.
func runOllama(ctx context.Context, turn Turn, emit func(Event)) []Message {
	settings := Settings()
	messages := append([]Message{{Role: "system", Content: systemPrompt(turn)}}, turn.Messages...)
	tools := toolDefinitions()

	var produced []Message
	for range settings.MaxToolCalls {
		reply, err := chat(ctx, settings, settings.Model, messages, tools)
		if err != nil {
			emit(Event{Kind: "error", Content: err.Error()})
			return produced
		}
		if reply.Thinking != "" {
			emit(Event{Kind: "thinking", Content: reply.Thinking})
		}
		remembered := forHistory(reply)
		messages = append(messages, remembered)
		produced = append(produced, remembered)

		if len(reply.ToolCalls) == 0 {
			// A local model occasionally returns a reply with no tool call and nothing
			// to say. Rendering that as an empty bubble reads as the app breaking, so
			// it is reported as what it is.
			if strings.TrimSpace(reply.Content) == "" {
				emit(Event{Kind: "error", Content: emptyAnswerReason(reply)})
				return produced
			}
			emit(Event{Kind: "message", Content: reply.Content})
			return produced
		}
		for _, call := range reply.ToolCalls {
			result := runTool(ctx, settings, turn, call, emit)
			messages = append(messages, result)
			produced = append(produced, result)
		}
	}

	emit(Event{Kind: "error", Content: fmt.Sprintf(
		"Stopped after %d tool calls without an answer — the model may be looping.", settings.MaxToolCalls)})
	return produced
}

// emptyAnswerReason distinguishes the two ways a model says nothing. Reasoning with no
// answer is a thinking model that ran out of room mid-thought; nothing at all is a model
// that simply produced no tokens.
func emptyAnswerReason(reply Message) string {
	if reply.Thinking != "" {
		return "The model reasoned but never wrote an answer — ask again, or turn thinking off."
	}
	return "The model returned an empty answer — ask again."
}

// forHistory strips reasoning from a reply before it is replayed into the next turn.
// Gemma's own guidance: drop previous turns' thinking, except on a turn that called a
// tool, where the reasoning is what connects the call to the result that follows it.
func forHistory(reply Message) Message {
	if len(reply.ToolCalls) > 0 {
		return reply
	}
	reply.Thinking = ""
	return reply
}

// runTool executes one tool call and returns the message carrying its result. A failure
// comes back as the result rather than ending the turn: the model has to see what went
// wrong to try something else.
func runTool(ctx context.Context, settings config.Assistant, turn Turn, call ToolCall, emit func(Event)) Message {
	name := call.Function.Name
	args := call.Function.Arguments
	if args == nil {
		args = mcp.Args{}
	}
	fillContext(args, turn)
	emit(Event{Kind: "tool", Tool: name, Detail: describeArgs(args)})

	text, err := dispatchTool(ctx, settings, name, args)
	if err != nil {
		text = "error: " + err.Error()
	}
	emit(Event{Kind: "tool_result", Tool: name, Detail: summarize(text)})
	return Message{Role: "tool", ToolName: name, Content: text}
}

// dispatchTool routes to the vision tool or to the MCP registry, and contains whatever
// happens in there. A tool is reached with arguments a model invented, so a panic in one
// must become this turn's problem rather than the backend's.
func dispatchTool(ctx context.Context, settings config.Assistant, name string, args mcp.Args) (text string, err error) {
	defer func() {
		if problem := recover(); problem != nil {
			err = fmt.Errorf("tool %s failed: %v", name, problem)
		}
	}()
	return callTool(ctx, settings, name, args)
}

func callTool(ctx context.Context, settings config.Assistant, name string, args mcp.Args) (string, error) {
	if name == lookToolName {
		return look(ctx, settings, args)
	}
	result, err := mcp.Call(ctx, name, args)
	if err != nil {
		return "", err
	}
	// An image in an MCP result is dropped here on purpose: this loop's model is the
	// tool-caller, and it is never shown pictures. look() is the way to see something.
	encoded, err := json.Marshal(result.Data)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// fillContext supplies the session and project the pane is open on when the model left
// them out, which small models do constantly.
func fillContext(args mcp.Args, turn Turn) {
	if _, given := args["sid"]; !given && turn.SID != "" {
		args["sid"] = turn.SID
	}
	if _, given := args["project"]; !given && turn.Project != "" {
		args["project"] = turn.Project
	}
}

func describeArgs(args mcp.Args) string {
	parts := make([]string, 0, len(args))
	for key, value := range args {
		if key == "graph" {
			parts = append(parts, "graph=…")
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%v", key, value))
	}
	return strings.Join(parts, " ")
}

// summarize keeps a tool result readable in the transcript; the model still gets it all.
func summarize(text string) string {
	const limit = 240
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "…"
}

func systemPrompt(turn Turn) string {
	var prompt strings.Builder
	prompt.WriteString(`You help run atlas, a tool for labeling video clips and images.

You read the data and suggest what to do. You cannot label anything yourself, run a
workflow, delete anything or change the taxonomy — a human does that. What you can do is
write proposals for a human to confirm, and save workflow drafts for them to run.

Work from evidence, not assumption: look at the session with ` + lookToolName + `, read
its entities and the project's insights before recommending anything. When you author a
workflow, call list_node_types first, then validate_workflow, then dry_run_workflow — a
graph that touches no entities is the usual mistake, and the dry run catches it. Answer
in a few sentences; say what you found and what you would do.`)

	if turn.SID != "" {
		prompt.WriteString("\n\nThe user is looking at session " + turn.SID + ".")
	}
	if turn.Project != "" {
		prompt.WriteString(" The project is " + turn.Project + ".")
	}
	return prompt.String()
}

// --- vision -----------------------------------------------------------------

const (
	lookToolName        = "look_at_session"
	lookToolDescription = "Look at a session's clips and describe what is actually in them. " +
		"Use this before recommending settings or authoring a workflow — it is the only way to " +
		"know whether a session is one static angle, a mix of scenes, or mostly junk."
)

func lookToolSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"sid":      map[string]any{"type": "string", "description": "session id"},
			"from":     map[string]any{"type": "integer", "description": "start at this entity position"},
			"question": map[string]any{"type": "string", "description": "what you want to know about them"},
		},
		"required": []string{"sid"},
	}
}

// look renders a contact sheet and asks the vision model to describe it. The description
// is what comes back to the tool-calling model — it never handles the image itself,
// which keeps each model doing the one thing it is good at.
func look(ctx context.Context, settings config.Assistant, args mcp.Args) (string, error) {
	if settings.VisionModel == "" {
		return "", fmt.Errorf("no vision model is configured, so the clips cannot be looked at")
	}
	session, err := sessions.Default.Get(ctx, args.String("sid"))
	if err != nil {
		return "", err
	}
	if session == nil {
		return "", fmt.Errorf("session %q not found", args.String("sid"))
	}

	picture, index, err := sheet.Render(ctx, session, args.Int("from", 0), sheet.DefaultTiles)
	if err != nil {
		return "", err
	}
	if len(index.Tiles) == 0 {
		return "This session has no entities to look at yet.", nil
	}

	question := args.String("question")
	if question == "" {
		question = "Describe what these clips show, and what they have in common."
	}
	encoded, err := encodeSheet(picture)
	if err != nil {
		return "", err
	}

	described, err := chat(ctx, settings, settings.VisionModel, []Message{{
		Role: "user",
		Content: fmt.Sprintf(
			"This is a contact sheet: %d thumbnails from one video, in order, %d per row. %s",
			len(index.Tiles), index.Columns, question),
		Images: []string{encoded},
	}}, nil)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Looked at %d of %d clips (from position %d): %s",
		len(index.Tiles), index.Total, index.From, described.Content), nil
}
