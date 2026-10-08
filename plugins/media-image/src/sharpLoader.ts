import type { Sharp } from "sharp";

type SharpFactory = (input: Buffer) => Sharp;

let cachedFactory: SharpFactory | null | undefined;

/** sharp is a native module; the plugin degrades gracefully when it cannot be loaded. */
export async function loadSharp(): Promise<SharpFactory | null> {
  if (cachedFactory !== undefined) {
    return cachedFactory;
  }
  try {
    const loaded = await import("sharp");
    cachedFactory = loaded.default as unknown as SharpFactory;
  } catch (error) {
    cachedFactory = null;
  }
  return cachedFactory;
}
