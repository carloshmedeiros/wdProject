export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - now);
  }

  return undefined;
}

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);
  return base + Math.floor(random() * 250);
}
