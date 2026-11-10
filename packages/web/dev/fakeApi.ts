/**
 * A tiny in-memory stand-in for the atlas server (docs/schema.md), for developing the UI.
 *
 *   bun packages/web/dev/fakeApi.ts                      # listens on :8190
 *   ATLAS_API_URL=http://localhost:8190 \
 *   ATLAS_WORKSPACE=packages/web/dev/workspace bun run dev   # in packages/web
 *
 * Adapters can push more data while it runs: POST /api/projects/scenes/items etc.
 */
import { removedIds, validateAnnotation, validateTaxonomy, itemLength } from '@atlas/contracts';
import type { Annotation, AnnotationInput, Asset, Item, ItemDetail, ItemStatus, ItemView, LiveEvent, Project, Suggestion, Taxonomy } from '@atlas/contracts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAssets, buildItems, buildSuggestions, PROJECT_ID, taxonomy } from './fixtures';

const PORT = Number(process.env.FAKE_API_PORT || 8190);
const MEDIA_URL = `http://localhost:${PORT}/media`;
const MEDIA_DIRECTORY = path.join(os.tmpdir(), 'atlas-fake-media');

interface ProjectData {
  project: Project;
  assets: Map<string, Asset>;
  items: Map<string, Item>;
  annotations: Map<string, Annotation>;
  suggestions: Suggestion[];
}

const projects = new Map<string, ProjectData>();
const sockets = new Set<Bun.ServerWebSocket<unknown>>();

function createProject(id: string, name: string, groups: Taxonomy['groups']): ProjectData {
  const data: ProjectData = {
    project: { id, name, taxonomy: { version: 1, groups } },
    assets: new Map(),
    items: new Map(),
    annotations: new Map(),
    suggestions: [],
  };
  projects.set(id, data);
  return data;
}

function seed(): void {
  const data = createProject(PROJECT_ID, 'Scene classification', taxonomy.groups);
  buildAssets(MEDIA_URL).forEach((asset) => data.assets.set(asset.id, asset));
  buildItems().forEach((item) => data.items.set(item.id, item));
  data.suggestions.push(...buildSuggestions());
}

function ensureMedia(): void {
  fs.mkdirSync(MEDIA_DIRECTORY, { recursive: true });
  const video = path.join(MEDIA_DIRECTORY, 'sample.mp4');
  const poster = path.join(MEDIA_DIRECTORY, 'poster.png');
  if (!fs.existsSync(video)) {
    Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=90:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-movflags', '+faststart', video]);
  }
  const playlist = path.join(MEDIA_DIRECTORY, 'hls', 'index.m3u8');
  if (!fs.existsSync(playlist)) {
    fs.mkdirSync(path.dirname(playlist), { recursive: true });
    Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-i', video, '-c', 'copy', '-hls_time', '4', '-hls_playlist_type', 'vod', playlist]);
  }
  if (!fs.existsSync(poster)) {
    Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', poster]);
  }
}

// --- helpers ---------------------------------------------------------------------------

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

function invalid(errors: string[]): Response {
  return json({ errors }, 422);
}

function broadcast(event: LiveEvent): void {
  const text = JSON.stringify(event);
  sockets.forEach((socket) => socket.send(text));
}

function statusOf(data: ProjectData, itemId: string): ItemStatus {
  const annotation = data.annotations.get(itemId);
  if (annotation === undefined) {
    return 'pending';
  }
  return annotation.status;
}

function priorityOf(data: ProjectData, itemId: string): number | undefined {
  const priorities = data.suggestions.filter((suggestion) => suggestion.itemId === itemId && suggestion.priority !== undefined).map((suggestion) => Number(suggestion.priority));
  if (priorities.length === 0) {
    return undefined;
  }
  return Math.max(...priorities);
}

function viewOf(data: ProjectData, item: Item): ItemView {
  const asset = data.assets.get(item.assetId);
  if (asset === undefined) {
    throw new Error(`item ${item.id} points at unknown asset ${item.assetId}`);
  }
  return { item, asset, status: statusOf(data, item.id), priority: priorityOf(data, item.id), annotation: data.annotations.get(item.id) };
}

/** Queue order: highest priority first, items without priority last, then push order. */
function orderedViews(data: ProjectData): ItemView[] {
  const views = [...data.items.values()].map((item) => viewOf(data, item));
  const rank = (view: ItemView) => (view.priority === undefined ? -1 : view.priority);
  return views.map((view, index) => ({ view, index })).sort((a, b) => rank(b.view) - rank(a.view) || a.index - b.index).map((entry) => entry.view);
}

function neighbours(data: ProjectData, item: Item): { previous?: ItemView; next?: ItemView } {
  const siblings = [...data.items.values()].filter((candidate) => candidate.assetId === item.assetId && candidate.span !== undefined);
  siblings.sort((a, b) => Number(a.span?.start) - Number(b.span?.start));
  const index = siblings.findIndex((candidate) => candidate.id === item.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  return { previous: previous && viewOf(data, previous), next: next && viewOf(data, next) };
}

function pushAll<T extends { id?: string }>(records: T[], store: (record: T) => void): { ok: number; errors: { id: string; message: string }[] } {
  records.forEach(store);
  return { ok: records.length, errors: [] };
}

// --- routes ----------------------------------------------------------------------------

async function handleProject(request: Request, data: ProjectData, rest: string[], url: URL): Promise<Response> {
  const [section, ...tail] = rest;
  if (section === undefined) {
    return handleProjectRoot(request, data);
  }
  if (section === 'taxonomy' && request.method === 'PUT') {
    return putTaxonomy(data, (await request.json()) as Taxonomy);
  }
  if (section === 'items' && tail.length === 0) {
    return request.method === 'POST' ? pushItems(data, await request.json()) : listItems(data, url);
  }
  if (section === 'items' && tail.length >= 1) {
    return handleItem(request, data, decodeURIComponent(tail[0]), tail[1]);
  }
  if (section === 'assets' && request.method === 'POST') {
    return json(pushAll((await request.json()) as Asset[], (asset) => data.assets.set(asset.id, asset)));
  }
  if (section === 'suggestions' && request.method === 'POST') {
    return pushSuggestions(data, (await request.json()) as Suggestion[]);
  }
  if (section === 'queue') {
    return nextItem(data, url);
  }
  return json({ errors: ['not found'] }, 404);
}

async function handleProjectRoot(request: Request, data: ProjectData): Promise<Response> {
  if (request.method === 'PATCH') {
    Object.assign(data.project, await request.json());
    return json(data.project);
  }
  return json(data.project);
}

function putTaxonomy(data: ProjectData, next: Taxonomy): Response {
  const errors = [...validateTaxonomy(next), ...removedIds(data.project.taxonomy, next).map((id) => `"${id}" cannot be removed, deprecate it`)];
  if (errors.length > 0) {
    return invalid(errors);
  }
  data.project.taxonomy = { version: data.project.taxonomy.version + 1, groups: next.groups };
  broadcast({ type: 'taxonomy', projectId: data.project.id, taxonomy: data.project.taxonomy });
  return json(data.project.taxonomy);
}

function pushItems(data: ProjectData, items: Item[]): Response {
  const result = pushAll(items, (item) => data.items.set(item.id, item));
  broadcast({ type: 'items', projectId: data.project.id, ids: items.map((item) => item.id) });
  return json(result);
}

function pushSuggestions(data: ProjectData, suggestions: Suggestion[]): Response {
  suggestions.forEach((suggestion) => {
    data.suggestions = data.suggestions.filter((old) => !(old.itemId === suggestion.itemId && old.source === suggestion.source));
    data.suggestions.push(suggestion);
  });
  broadcast({ type: 'suggestions', projectId: data.project.id, ids: suggestions.map((suggestion) => suggestion.itemId) });
  return json({ ok: suggestions.length, errors: [] });
}

function listItems(data: ProjectData, url: URL): Response {
  const status = url.searchParams.get('status');
  const limit = Number(url.searchParams.get('limit') || 50);
  const offset = Number(url.searchParams.get('cursor') || 0);
  const views = orderedViews(data).filter((view) => status === null || view.status === status);
  const page = views.slice(offset, offset + limit);
  const more = offset + limit < views.length;
  return json({ items: page, cursor: more ? String(offset + limit) : undefined });
}

function nextItem(data: ProjectData, url: URL): Response {
  const views = orderedViews(data);
  const pending = views.filter((view) => view.status === 'pending');
  const after = url.searchParams.get('after');
  const afterIndex = views.findIndex((view) => view.item.id === after);
  const following = pending.find((view) => views.indexOf(view) > afterIndex);
  const chosen = following || pending.find((view) => view.item.id !== after);
  return json({ item: chosen, pending: pending.length });
}

async function handleItem(request: Request, data: ProjectData, itemId: string, tail: string | undefined): Promise<Response> {
  const item = data.items.get(itemId);
  if (item === undefined) {
    return json({ errors: [`unknown item ${itemId}`] }, 404);
  }
  if (tail === 'annotation') {
    return handleAnnotation(request, data, item);
  }
  const detail: ItemDetail = { ...viewOf(data, item), suggestions: data.suggestions.filter((suggestion) => suggestion.itemId === itemId), ...neighbours(data, item) };
  return json(detail);
}

async function handleAnnotation(request: Request, data: ProjectData, item: Item): Promise<Response> {
  if (request.method === 'DELETE') {
    data.annotations.delete(item.id);
    broadcast({ type: 'annotation', projectId: data.project.id, change: { cursor: String(Date.now()), itemId: item.id, kind: 'deleted' } });
    return new Response(null, { status: 204, headers: CORS });
  }
  const input = (await request.json()) as AnnotationInput;
  const asset = data.assets.get(item.assetId);
  const errors = validateAnnotation(data.project.taxonomy, input, itemLength(item, asset?.duration));
  if (errors.length > 0) {
    return invalid(errors);
  }
  const annotation: Annotation = { ...input, itemId: item.id, taxonomyVersion: data.project.taxonomy.version, updatedAt: new Date().toISOString() };
  data.annotations.set(item.id, annotation);
  broadcast({ type: 'annotation', projectId: data.project.id, change: { cursor: String(Date.now()), itemId: item.id, kind: 'saved', annotation } });
  return json(annotation);
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  if (parts[0] !== 'projects') {
    return json({ errors: ['not found'] }, 404);
  }
  if (parts.length === 1) {
    return handleProjects(request);
  }
  const data = projects.get(decodeURIComponent(parts[1]));
  if (data === undefined) {
    return json({ errors: ['unknown project'] }, 404);
  }
  return handleProject(request, data, parts.slice(2), url);
}

async function handleProjects(request: Request): Promise<Response> {
  if (request.method === 'POST') {
    const input = (await request.json()) as { id: string; name: string };
    if (projects.has(input.id)) {
      return invalid([`project "${input.id}" exists already`]);
    }
    const data = createProject(input.id, input.name, []);
    broadcast({ type: 'projects' });
    return json(data.project);
  }
  const summaries = [...projects.values()].map((data) => {
    const statuses = [...data.items.keys()].map((itemId) => statusOf(data, itemId));
    return { id: data.project.id, name: data.project.name, items: statuses.length, labeled: statuses.filter((status) => status === 'labeled').length, skipped: statuses.filter((status) => status === 'skipped').length };
  });
  return json(summaries);
}

/** Serves a file with Range support, like the media servers atlas expects. */
function serveMedia(request: Request, name: string): Response {
  const file = Bun.file(path.join(MEDIA_DIRECTORY, name));
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range === null) {
    return new Response(file, { headers: { ...CORS, 'Accept-Ranges': 'bytes' } });
  }
  const start = Number(range[1] || 0);
  const end = Math.min(Number(range[2] || file.size - 1), file.size - 1);
  const headers = { ...CORS, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Type': file.type };
  return new Response(file.slice(start, end + 1), { status: 206, headers });
}

seed();
ensureMedia();

Bun.serve({
  port: PORT,
  fetch(request, server) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/api/live' && server.upgrade(request)) {
      return undefined;
    }
    if (url.pathname.startsWith('/media/')) {
      return serveMedia(request, url.pathname.slice('/media/'.length));
    }
    return handleApi(request, url);
  },
  websocket: {
    open: (socket) => void sockets.add(socket),
    close: (socket) => void sockets.delete(socket),
    message: () => undefined,
  },
});

console.log(`fake atlas API on http://localhost:${PORT} (media in ${MEDIA_DIRECTORY})`);
