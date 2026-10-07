// Trigger dispatch runs workflows in response to lifecycle events. A config
// workflow whose triggers include the fired event is submitted as a background
// job; "manual" workflows only run from the Run button.
//
// Each trigger carries an input shape (its InputKind): program start has no
// input, session events operate over the whole session, and image events scope
// the run to a single image.
package workers

import (
	"fmt"

	"atlas/backend/internal/config"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/sessions"
)

// Trigger event names. Kept in sync with the frontend TRIGGERS list.
const (
	TriggerManual         = "manual"
	TriggerProgramStarted = "program_started"
	TriggerSessionCreated = "session_created"
	TriggerSessionOpened  = "session_opened"
	TriggerSessionClosed  = "session_closed"
	TriggerImageOpened    = "image_opened"
	TriggerImageAccepted  = "image_accepted"
	TriggerImageRejected  = "image_rejected"
)

// Input shapes a trigger provides to the workflow's entry node.
const (
	InputNone    = "none"    // program start — no session, no image
	InputSession = "session" // operates over the whole session's images
	InputImage   = "image"   // scoped to a single image
)

// InputKind returns the input shape for a trigger.
func InputKind(trigger string) string {
	switch trigger {
	case TriggerProgramStarted:
		return InputNone
	case TriggerImageOpened, TriggerImageAccepted, TriggerImageRejected:
		return InputImage
	default:
		return InputSession
	}
}

// FireTrigger runs every workflow bound to a session-scoped (or program) trigger.
func FireTrigger(trigger string, session *sessions.Session) {
	fire(trigger, session, -1)
}

// FireImageTrigger runs every workflow bound to an image-scoped trigger, passing
// the triggering image index so the run is scoped to that one image.
func FireImageTrigger(trigger string, session *sessions.Session, imageIdx int) {
	fire(trigger, session, imageIdx)
}

func fire(trigger string, session *sessions.Session, imageIdx int) {
	for _, workflow := range config.Get().Workflows {
		if workflow.Graph == nil || !containsTrigger(workflow.Triggers, trigger) {
			continue
		}
		// A workflow written for another project would run its nodes against the
		// wrong content kind and model pool, so it never fires here.
		if session != nil && !workflow.RunsFor(session.Project) {
			continue
		}
		sid := ""
		if session != nil {
			sid = session.ID
		}
		runCtx := RunContext{Session: session, ImageIdx: imageIdx}
		graph := workflow.Graph
		id := workflow.ID
		label := workflow.Label
		jobs.Default.Submit("workflow", sid, 0, map[string]any{"workflow": id, "trigger": trigger}, func(job *jobs.Job) error {
			if runCtx.Session == nil {
				return fmt.Errorf("workflow %q requires a session", id)
			}
			return RunAndNotify(runCtx, graph, label, job)
		})
	}
}

func containsTrigger(triggers []string, trigger string) bool {
	for _, candidate := range triggers {
		if candidate == trigger {
			return true
		}
	}
	return false
}
