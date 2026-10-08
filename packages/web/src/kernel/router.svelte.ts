import type { Registry, RouteContribution } from '@atlas/contracts/web';

export interface RouteMatch {
  route: RouteContribution;
  params: Record<string, string>;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Returns decoded `:param` values when the path matches the pattern, otherwise undefined. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const patternSegments = segmentsOf(pattern);
  const pathSegments = segmentsOf(path);
  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) {
      return undefined;
    }
  }
  return params;
}

function literalCount(pattern: string): number {
  return segmentsOf(pattern).filter((segment) => !segment.startsWith(':')).length;
}

/** Picks the matching route with the most literal segments, so `/a/new` beats `/a/:id`. */
export function matchRoute(routes: RouteContribution[], path: string): RouteMatch | undefined {
  let best: RouteMatch | undefined;
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (!params) {
      continue;
    }
    if (!best || literalCount(route.path) > literalCount(best.route.path)) {
      best = { route, params };
    }
  }
  return best;
}

export class Router {
  path = $state('/');
  current: RouteMatch | undefined;

  constructor(routes: Registry<RouteContribution>, initialPath: string) {
    this.path = initialPath;
    this.current = $derived(matchRoute(routes.list(), this.path));
  }

  navigate(target: string, options: { replace?: boolean } = {}): void {
    if (target === location.pathname + location.search) {
      return;
    }
    if (options.replace) {
      history.replaceState(null, '', target);
    } else {
      history.pushState(null, '', target);
    }
    this.syncFromLocation();
  }

  /** Called on popstate and after programmatic navigation. */
  syncFromLocation(): void {
    this.path = location.pathname;
  }
}
