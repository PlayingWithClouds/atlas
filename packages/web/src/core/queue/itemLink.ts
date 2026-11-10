/** Route of the labeling screen for one item; ids contain `#`, `:` and `/`, so they are encoded. */
export function labelPath(projectId: string, itemId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/label/${encodeURIComponent(itemId)}`;
}

export function queuePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/queue`;
}

export function apiItemPath(projectId: string, itemId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`;
}
