import type { ProcessMessage } from "./types";

export function parseCheckBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const token = (body as { token?: unknown }).token;
  if (typeof token !== "string" || token.length === 0) return null;
  return token;
}

export function parseProcessBody(body: unknown): ProcessMessage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { run_id?: unknown; seq?: unknown; sku?: unknown };
  if (typeof record.run_id !== "string" || record.run_id.length === 0) return null;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq)) return null;
  if (typeof record.sku !== "string" || record.sku.length === 0) return null;
  return { runId: record.run_id, seq: record.seq, sku: record.sku };
}

export function normalizeWebhook(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search || url.username) return null;
    return url.origin;
  } catch {
    return null;
  }
}
