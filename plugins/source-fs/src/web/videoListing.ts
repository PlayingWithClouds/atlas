const PAGE_SIZE = 40;

export function videoListingPath(search: string): string {
  const query = `search=${encodeURIComponent(search)}&limit=${PAGE_SIZE}&offset=0`;
  return `/sources/fs/videofile/items?${query}`;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}
