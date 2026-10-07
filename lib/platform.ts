import { EnrichError, PlatformError } from "./errors";
import { parseRetryAfter } from "./retry";
import type { CallbackPayload, Credentials, Enrichment } from "./types";

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function platformMessage(status: number, body: unknown, fallback: string) {
  if (body && typeof body === "object") {
    const record = body as { error?: unknown; reason?: unknown; message?: unknown };
    const reason = [record.error, record.reason, record.message]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join(": ");
    if (reason) return reason;
  }
  if (typeof body === "string" && body.length > 0) return body;
  return `${fallback} (HTTP ${status})`;
}

export async function registerWebhook(
  baseUrl: string,
  name: string,
  webhook: string,
): Promise<Pick<Credentials, "cid" | "token">> {
  const response = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, webhook }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new PlatformError(platformMessage(response.status, body, "Falha no registro"), response.status, body);
  }
  if (!body || typeof body !== "object") {
    throw new PlatformError("Resposta de registro inválida", response.status, body);
  }
  const record = body as { cid?: unknown; token?: unknown };
  if (typeof record.cid !== "string" || typeof record.token !== "string") {
    throw new PlatformError("Resposta de registro sem cid ou token", response.status, body);
  }
  return { cid: record.cid, token: record.token };
}

export async function requestBurst(
  baseUrl: string,
  cid: string,
  token: string,
): Promise<{ runId: string; total: number; startedAt: string }> {
  const response = await fetch(`${baseUrl}/burst/${encodeURIComponent(cid)}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-token": token },
    body: "{}",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new PlatformError(platformMessage(response.status, body, "Falha ao solicitar o lote"), response.status, body);
  }
  if (!body || typeof body !== "object") {
    throw new PlatformError("Resposta de lote inválida", response.status, body);
  }
  const record = body as { run_id?: unknown; total?: unknown; started_at?: unknown };
  if (typeof record.run_id !== "string" || typeof record.total !== "number") {
    throw new PlatformError("Resposta de lote sem run_id ou total", response.status, body);
  }
  return {
    runId: record.run_id,
    total: record.total,
    startedAt: typeof record.started_at === "string" ? record.started_at : new Date().toISOString(),
  };
}

export async function enrichSku(
  baseUrl: string,
  cid: string,
  token: string,
  sku: string,
): Promise<Enrichment> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/enrich/${encodeURIComponent(sku)}`, {
      headers: { accept: "application/json", "x-cid": cid, "x-token": token },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "falha de rede";
    throw new EnrichError(message, { retryable: true });
  }

  if (response.status === 200) {
    const body = await readBody(response);
    if (!body || typeof body !== "object") {
      throw new EnrichError("payload de enriquecimento inválido", { retryable: true });
    }
    const record = body as { sku?: unknown; price?: unknown; stock?: unknown };
    if (typeof record.price !== "number" || typeof record.stock !== "number") {
      throw new EnrichError("preço ou estoque ausente", { retryable: true });
    }
    return {
      sku: typeof record.sku === "string" ? record.sku : sku,
      price: record.price,
      stock: record.stock,
    };
  }

  if (response.status === 429) {
    const hinted = parseRetryAfter(response.headers.get("retry-after"));
    throw new EnrichError("limite de concorrência do enriquecimento", {
      retryable: true,
      retryAfterMs: Math.max(200, hinted ?? 1000),
    });
  }

  if (response.status === 401 || response.status === 404) {
    throw new EnrichError(`enriquecimento recusado (${response.status})`, { retryable: false });
  }

  throw new EnrichError(`falha transitória do enriquecimento (${response.status})`, { retryable: true });
}

export async function sendCallback(
  baseUrl: string,
  token: string,
  payload: CallbackPayload,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}/callback`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-token": token },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new PlatformError(platformMessage(response.status, body, "Falha no callback"), response.status, body);
  }
  return body;
}
