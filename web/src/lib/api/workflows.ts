import { get, post, del } from './client';
import type { Job } from './types';

export type WorkflowNode = {
	id: string;
	type: string;
	params?: Record<string, unknown>;
	pos: { x: number; y: number };
};

export type WorkflowEdge = { source: string; target: string };

export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

export type Workflow = {
	id: string;
	label: string;
	// The project that owns the workflow. Absent on workflows saved before scoping
	// existed; those still run for every project until they are saved again.
	project?: string;
	triggers?: string[];
	graph?: WorkflowGraph;
};

// A trigger's input shape decides what its workflow's Source node receives.
export type InputKind = 'none' | 'session' | 'image';

// Workflow triggers — kept in sync with backend workers/triggers.go.
export const TRIGGERS: { value: string; label: string; input: InputKind }[] = [
	{ value: 'manual', label: 'Manual (Run button)', input: 'session' },
	{ value: 'program_started', label: 'Program started', input: 'none' },
	{ value: 'session_created', label: 'Session created', input: 'session' },
	{ value: 'session_opened', label: 'Session opened', input: 'session' },
	{ value: 'session_closed', label: 'Session closed', input: 'session' },
	{ value: 'image_opened', label: 'Image opened', input: 'image' },
	{ value: 'image_accepted', label: 'Image accepted', input: 'image' },
	{ value: 'image_rejected', label: 'Image rejected', input: 'image' }
];

export function triggerLabel(value: string): string {
	const found = TRIGGERS.find((trigger) => trigger.value === value);
	return found ? found.label : value;
}

export function triggerInput(value: string): InputKind {
	const found = TRIGGERS.find((trigger) => trigger.value === value);
	return found ? found.input : 'session';
}

// The Source node's shape for a set of triggers. Empty/manual defaults to session.
export function inputKindFor(triggers: string[] | undefined): InputKind {
	if (!triggers || triggers.length === 0) return 'session';
	return triggerInput(triggers[0]);
}

export const INPUT_LABEL: Record<InputKind, string> = {
	none: 'No input',
	session: 'Session images',
	image: 'Single image'
};

// Node catalog — mirrors backend/internal/nodes.Spec. `source` is "builtin" or a
// plugin id; plugin nodes only appear while their plugin is healthy.
export type NodeParam = {
	key: string;
	kind: 'string' | 'text' | 'number' | 'option';
	label: string;
	default: unknown;
	options?: string[];
	placeholder?: string;
	min?: number;
	max?: number;
	step?: number;
};

export type NodeSpec = {
	type: string;
	label: string;
	description: string;
	input: string;
	output: string;
	source: string;
	plugin?: string;
	method?: string;
	batch?: number;
	accepts?: Record<string, unknown>;
	emits?: Record<string, unknown>;
	params: NodeParam[];
};

// With a project, only the workflows that project owns (plus any saved before
// workflows were scoped, which still run everywhere).
export function listWorkflows(project?: string): Promise<{ workflows: Workflow[] }> {
	if (!project) return get('/api/workflows');
	return get(`/api/workflows?project=${encodeURIComponent(project)}`);
}

// With a project, the catalog is narrowed to the nodes that project can run — a clip
// project is not offered frame extraction or another backbone's embed node.
export function getNodeCatalog(project?: string): Promise<{ nodes: NodeSpec[] }> {
	if (!project) return get('/api/workflows/nodes');
	return get(`/api/workflows/nodes?project=${encodeURIComponent(project)}`);
}

export function saveWorkflow(workflow: Workflow): Promise<{ ok: boolean; workflows: Workflow[] }> {
	return post('/api/workflows', workflow);
}

export function deleteWorkflow(id: string): Promise<{ ok: boolean; workflows: Workflow[] }> {
	return del(`/api/workflows/${id}`);
}

// What a graph would do, checked without running it. Errors mean it cannot run;
// warnings mean it can, but probably not the way its author meant.
export type GraphReport = { ok: boolean; errors: string[]; warnings: string[] };

export type NodeEstimate = {
	id: string;
	type: string;
	in: number;
	matched: number;
	passthrough: number;
	out: number;
	note?: string;
};

export type DryRunReport = { report: GraphReport; entities: number; nodes: NodeEstimate[] };

export function validateWorkflow(graph: WorkflowGraph, project?: string): Promise<GraphReport> {
	return post('/api/workflows/validate', { graph, project });
}

// Counts only: the dry run walks the stream without calling plugins or writing
// anything, so it knows how many entities reach each node, not what they become.
export function dryRunWorkflow(sid: string, graph: WorkflowGraph): Promise<DryRunReport> {
	return post(`/api/sessions/${sid}/workflow/dry-run`, { graph });
}

// already_running comes back instead of a job when the session still has a workflow
// in flight; the backend refuses to stack a second run on the same session.
export function runWorkflow(
	sid: string,
	workflowId: string
): Promise<{ ok: boolean; job?: Job; started?: boolean; already_running?: boolean }> {
	return post(`/api/sessions/${sid}/workflow/${workflowId}`, {});
}
