/**
 * Veil data-source plugin (TypeScript / Bun).
 *
 * Wraps the veil media server (galleries + scenes) behind the standard `source`
 * capability. All veil/GraphQL knowledge lives here — the core app only talks to this
 * plugin over JSON-RPC.
 *
 * Run:  bun plugins/veil/index.ts   (or: task plugin:veil)
 * Env:  VEIL_URL (default http://localhost:8080)
 */

import { Plugin } from "@atlas/plugin-sdk";
import {
  galleryImageUrls,
  imageProxyUrl,
  listGalleries,
  listScenes,
  sceneStreamUrl,
} from "./veil";

const PORT = Number(process.env.VEIL_PLUGIN_PORT || 9101);

function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function sample<T>(array: T[], count: number): T[] {
  return shuffle([...array]).slice(0, count);
}

const plugin = new Plugin("veil");
plugin.declare("source", { kinds: ["gallery", "scene", "random"], browsable: true });

plugin.method("source.kinds", async () => ({
  kinds: [
    { id: "gallery", label: "Galleries", itemNoun: "gallery", browsable: true, thumbnails: true, layout: "grid" },
    { id: "scene", label: "Scenes", itemNoun: "scene", browsable: true, thumbnails: true, layout: "grid" },
    { id: "random", label: "Random", itemNoun: "image", browsable: true, thumbnails: true, layout: "grid", sample: true },
  ],
}));

plugin.method("source.list", async ({ kind, search = "", limit = 40, offset = 0 }: any) => {
  if (kind === "gallery") {
    const galleries = await listGalleries(search, limit, offset);
    return {
      items: galleries.map((g) => ({
        id: g.id,
        title: g.title,
        thumbnail: g.coverPath,
        count: g.imageCount,
      })),
    };
  }
  if (kind === "scene") {
    const scenes = await listScenes(search, limit, offset);
    return {
      items: scenes.map((s) => ({
        id: s.id,
        title: s.title,
        thumbnail: s.posterPath,
        duration: s.durationSeconds,
      })),
    };
  }
  throw new Error(`unknown kind: ${kind}`);
});

plugin.method("source.resolve", async ({ kind, id, interval = 20, images, count = 20 }: any) => {
  if (kind === "gallery") {
    const { title, urls } = await galleryImageUrls(id);
    return { label: title, items: urls.map(imageProxyUrl) };
  }
  if (kind === "scene") {
    const { url, headers } = await sceneStreamUrl(id);
    return { label: `scene ${id}`, items: [], stream: { url, headers, interval } };
  }
  if (kind === "random") {
    const urls: string[] = images || (await sampleUrls(count));
    if (urls.length === 0) throw new Error("no images available");
    return { label: `Random ${urls.length}`, items: urls.map(imageProxyUrl) };
  }
  throw new Error(`unknown kind: ${kind}`);
});

plugin.method("source.sample", async ({ count = 60, per = 4, exclude }: any) => {
  const excludeSet = new Set<string>(exclude || []);
  let galleries = await listGalleries("", 100, Math.floor(Math.random() * 301));
  if (galleries.length === 0) galleries = await listGalleries("", 100, 0);
  shuffle(galleries);

  const out: Array<{ galleryId: string; gallery: string; url: string }> = [];
  for (const gallery of galleries) {
    if (out.length >= count) break;
    let title: string;
    let urls: string[];
    try {
      ({ title, urls } = await galleryImageUrls(gallery.id));
    } catch {
      continue;
    }
    shuffle(urls);
    let picked = 0;
    for (const url of urls) {
      if (picked >= per || out.length >= count) break;
      if (excludeSet.has(imageProxyUrl(url))) continue;
      out.push({ galleryId: gallery.id, gallery: title, url });
      picked += 1;
    }
  }
  return { items: shuffle(out).slice(0, count) };
});

async function sampleUrls(count: number, perGallery = 4): Promise<string[]> {
  let galleries = await listGalleries("", 100, Math.floor(Math.random() * 301));
  if (galleries.length === 0) galleries = await listGalleries("", 100, 0);
  shuffle(galleries);

  const urls: string[] = [];
  for (const gallery of galleries) {
    if (urls.length >= count) break;
    let galleryUrls: string[];
    try {
      ({ urls: galleryUrls } = await galleryImageUrls(gallery.id));
    } catch {
      continue;
    }
    if (galleryUrls.length === 0) continue;
    urls.push(...sample(galleryUrls, Math.min(perGallery, galleryUrls.length)));
  }
  return shuffle(urls).slice(0, count);
}

plugin.serve(PORT);
