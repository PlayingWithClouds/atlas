import { timingSafeEqual } from "node:crypto";

export const LIVE_SOCKET_PATHS = ["/api/live", "/api/ws"];

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  if (address === "::1") {
    return true;
  }
  const ipv4Address = address.replace(/^::ffff:/, "");
  return ipv4Address.startsWith("127.");
}

function sameText(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  if (firstBytes.length !== secondBytes.length) {
    return false;
  }
  return timingSafeEqual(firstBytes, secondBytes);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length).trim();
}

/** Browsers cannot set headers on a WebSocket, so the live socket may carry the token in `?token=`. */
function socketToken(request: Request): string | undefined {
  const url = new URL(request.url);
  if (!LIVE_SOCKET_PATHS.includes(url.pathname)) {
    return undefined;
  }
  const token = url.searchParams.get("token");
  if (token === null) {
    return undefined;
  }
  return token;
}

export function presentedToken(request: Request): string | undefined {
  const bearer = bearerToken(request);
  if (bearer !== undefined) {
    return bearer;
  }
  return socketToken(request);
}

/** Loopback is always trusted; other machines need a configured token once any exists. */
export function isAuthorized(request: Request, remoteAddress: string | undefined, tokens: { token: string }[]): boolean {
  if (tokens.length === 0 || isLoopbackAddress(remoteAddress)) {
    return true;
  }
  const presented = presentedToken(request);
  if (presented === undefined) {
    return false;
  }
  return tokens.some((entry) => sameText(entry.token, presented));
}
