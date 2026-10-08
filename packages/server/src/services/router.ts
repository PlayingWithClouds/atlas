import type { RouteHandler, RouteParams } from "@atlas/contracts/server";

export interface RouteEntry {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export interface RouteMatch {
  entry: RouteEntry;
  params: RouteParams;
}

export function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function matchSegment(patternSegment: string, pathSegment: string, params: RouteParams): boolean {
  if (patternSegment.startsWith(":")) {
    params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
    return true;
  }
  return patternSegment === pathSegment;
}

export function matchSegments(patternSegments: string[], pathSegments: string[]): RouteParams | undefined {
  const params: RouteParams = {};
  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index];
    if (patternSegment === "*") {
      params["*"] = pathSegments.slice(index).map(decodeURIComponent).join("/");
      return params;
    }
    if (index >= pathSegments.length) {
      return undefined;
    }
    if (!matchSegment(patternSegment, pathSegments[index], params)) {
      return undefined;
    }
  }
  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }
  return params;
}

export class Router {
  private readonly entries: RouteEntry[] = [];

  add(method: string, pattern: string, handler: RouteHandler): () => void {
    const entry: RouteEntry = { method: method.toUpperCase(), segments: splitPath(pattern), handler };
    this.entries.push(entry);
    return () => {
      const entryIndex = this.entries.indexOf(entry);
      if (entryIndex !== -1) {
        this.entries.splice(entryIndex, 1);
      }
    };
  }

  match(method: string, pathname: string): RouteMatch | undefined {
    const pathSegments = splitPath(pathname);
    for (const entry of this.entries) {
      if (entry.method !== method) {
        continue;
      }
      const params = matchSegments(entry.segments, pathSegments);
      if (params) {
        return { entry, params };
      }
    }
    return undefined;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
