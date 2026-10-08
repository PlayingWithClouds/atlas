import type { Item } from "@atlas/contracts";
import type { SourcesService } from "@atlas/contracts/server";
import { readBytes, serveLocation } from "./delivery";
import { loadSharp } from "./sharpLoader";

const THUMBNAIL_WIDTH = 320;

async function resize(bytes: Buffer): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (sharp === null) {
    return null;
  }
  try {
    return await sharp(bytes)
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  } catch (error) {
    // Undecodable input: the browser gets the original instead of an error.
    return null;
  }
}

/** Resized preview; serves the original when sharp is missing or cannot decode the file. */
export async function serveThumbnail(sources: SourcesService, item: Item, request: Request): Promise<Response> {
  const location = await sources.locate(item);
  if ((await loadSharp()) === null) {
    return serveLocation(location, request);
  }
  const bytes = await readBytes(location);
  const resized = await resize(bytes);
  if (resized === null) {
    return serveLocation(location, request);
  }
  return new Response(new Uint8Array(resized), {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=300" },
  });
}
