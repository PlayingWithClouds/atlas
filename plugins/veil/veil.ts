/**
 * Minimal veil GraphQL client.
 *
 * Reads gallery images and scene lists, and resolves a scene's playable stream URL
 * via the ensureSceneStreams mutation. Port of the former backend/veil.py.
 */

const VEIL_URL = process.env.VEIL_URL || "http://localhost:8080";

async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${VEIL_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  // A non-JSON response (upstream down, wrong VEIL_URL, HTML error page) makes
  // response.json() throw the opaque "Failed to parse JSON" — surface the real cause.
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `veil graphql ${VEIL_URL} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 120)}`
    );
  }
  if (body.errors) {
    throw new Error(body.errors[0]?.message || "graphql error");
  }
  return body.data;
}

/** Route remote images through veil's cache/hotlink proxy. */
export function imageProxyUrl(remoteUrl: string): string {
  return `${VEIL_URL}/api/img?url=${encodeURIComponent(remoteUrl)}`;
}

export interface Gallery {
  id: string;
  title: string;
  coverPath?: string;
  imageCount?: number;
}

export async function listGalleries(search: string, limit: number, offset: number): Promise<Gallery[]> {
  const query = `
    query($search:String,$limit:Int,$offset:Int){
      galleries(search:$search,limit:$limit,offset:$offset){
        id title coverPath imageCount
      }
    }
  `;
  const data = await graphql(query, { search: search || null, limit, offset });
  return data.galleries;
}

export async function galleryImageUrls(galleryId: string): Promise<{ title: string; urls: string[] }> {
  const query = `
    query($id:ID!){
      gallery(id:$id){ id title images{ filePath position } }
    }
  `;
  const data = await graphql(query, { id: galleryId });
  const gallery = data.gallery;
  if (gallery === null) {
    throw new Error("gallery not found");
  }
  const images = [...gallery.images].sort(
    (a: any, b: any) => (a.position || 0) - (b.position || 0),
  );
  const urls = images.map((image: any) => image.filePath).filter((path: string) => Boolean(path));
  return { title: gallery.title, urls };
}

export interface Scene {
  id: string;
  title: string;
  posterPath?: string;
  durationSeconds?: number;
}

export async function listScenes(search: string, limit: number, offset: number): Promise<Scene[]> {
  const query = `
    query($search:String,$limit:Int,$offset:Int){
      scenes(search:$search,limit:$limit,offset:$offset){
        id title posterPath durationSeconds
      }
    }
  `;
  const data = await graphql(query, { search: search || null, limit, offset });
  return data.scenes;
}

/**
 * Resolve a scene to a directly-playable URL + request headers.
 *
 * ensureSceneStreams returns provider embed pages which ffmpeg cannot read. The
 * `stream` query runs the plugin resolver, turning an embed page into a direct/proxied
 * media URL (mp4 or HLS manifest) served by veil, plus any headers the CDN requires.
 */
export async function sceneStreamUrl(sceneId: string): Promise<{ url: string; headers: Record<string, string> }> {
  const ensure = `
    mutation($id:ID!){
      ensureSceneStreams(sceneId:$id){ url kind format mimeType resolution }
    }
  `;
  const streams = (await graphql(ensure, { id: sceneId })).ensureSceneStreams;
  if (!streams || streams.length === 0) {
    throw new Error("scene has no playable streams");
  }

  const embedUrl = pickBestStream(streams);

  const resolve = `
    query($url:String!){
      stream(url:$url){ url mimeType headers{ name value } }
    }
  `;
  const result = (await graphql(resolve, { url: embedUrl })).stream;
  if (result === null || !result.url) {
    throw new Error("could not resolve a playable stream url");
  }

  const headers: Record<string, string> = {};
  for (const header of result.headers || []) {
    headers[header.name] = header.value;
  }
  return { url: result.url, headers };
}

function pickBestStream(streams: any[]): string {
  const score = (stream: any): number => {
    let value = 0;
    if (stream.kind === "stream") value += 2;
    const format = (stream.format || "").toLowerCase();
    const mime = (stream.mimeType || "").toLowerCase();
    if (format.includes("mp4") || mime.includes("mp4")) value += 1;
    return value;
  };
  let best = streams[0];
  for (const stream of streams) {
    if (score(stream) > score(best)) best = stream;
  }
  return best.url;
}
