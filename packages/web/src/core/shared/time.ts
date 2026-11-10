/** `m:ss` or `h:mm:ss`; `decimals` adds fractions of a second. */
export function formatClock(seconds: number, decimals = 0): string {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, '0');
  let fraction = '';
  if (decimals > 0) {
    fraction = `.${String(Math.floor((safe - whole) * 10 ** decimals)).padStart(decimals, '0')}`;
  }
  if (minutes < 60) {
    return `${minutes}:${rest}${fraction}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${rest}${fraction}`;
}

export function formatSpan(span: { start: number; end: number }): string {
  return `${formatClock(span.start)}–${formatClock(span.end)}`;
}
