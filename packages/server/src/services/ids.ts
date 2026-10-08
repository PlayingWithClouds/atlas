/** Short random identifier; no domain meaning, safe in URLs. */
export function shortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
