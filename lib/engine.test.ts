import { describe, expect, it } from "vitest";
import { EnrichError } from "./errors";
import { BatchEngine } from "./engine";
import { parseCheckBody, parseProcessBody, normalizeWebhook } from "./parse";
import { parseRetryAfter, backoffMs } from "./retry";
import type { CallbackResultItem } from "./types";

function waitFor(predicate: () => boolean, timeout = 2500) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error("tempo esgotado aguardando a condição"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createEngine(options: {
  concurrency?: number;
  maxAttempts?: number;
  enrich: (sku: string) => Promise<{ sku: string; price: number; stock: number }>;
  deliver?: (payload: { run_id: string; result: CallbackResultItem[] }) => Promise<unknown>;
}) {
  const delivered: Array<{ run_id: string; result: CallbackResultItem[] }> = [];
  const engine = new BatchEngine({
    concurrency: options.concurrency ?? 3,
    maxAttempts: options.maxAttempts ?? 5,
    enrich: options.enrich,
    deliver: async (payload) => {
      delivered.push(payload);
      if (options.deliver) return options.deliver(payload);
      return { ok: true };
    },
  });
  return { engine, delivered };
}

describe("parse", () => {
  it("aceita o contrato de /check e /process", () => {
    expect(parseCheckBody({ token: "a3f9" })).toBe("a3f9");
    expect(parseCheckBody({ token: "" })).toBeNull();
    expect(parseCheckBody(null)).toBeNull();
    expect(parseProcessBody({ run_id: "run", seq: 0, sku: "sku-001" })).toEqual({
      runId: "run",
      seq: 0,
      sku: "sku-001",
    });
    expect(parseProcessBody({ run_id: "run", seq: 1.5, sku: "sku-001" })).toBeNull();
    expect(normalizeWebhook("https://exemplo.ngrok.app/")).toBe("https://exemplo.ngrok.app");
    expect(normalizeWebhook("http://localhost:4000")).toBeNull();
  });

  it("interpreta retry-after em segundos e em data", () => {
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter("2")).toBe(2000);
    const now = Date.parse("2026-08-03T12:00:00Z");
    expect(parseRetryAfter("Mon, 03 Aug 2026 12:00:01 GMT", now)).toBe(1000);
    expect(parseRetryAfter("nao-e-data")).toBeUndefined();
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(6, () => 0)).toBe(8000);
  });
});

describe("BatchEngine", () => {
  it("confirma o recebimento antes do enriquecimento terminar", () => {
    let finished = false;
    const { engine } = createEngine({
      enrich: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            finished = true;
            resolve({ sku: "sku-1", price: 10, stock: 1 });
          }, 40);
        }),
    });

    const receipt = engine.ingest({ runId: "run", seq: 0, sku: "sku-1" });
    expect(receipt.duplicate).toBe(false);
    expect(finished).toBe(false);
    expect(engine.snapshot().runs[0]?.items[0]?.status).not.toBe("done");
  });

  it("deduplica por run_id e seq e reprocessa apenas falha definitiva", async () => {
    let calls = 0;
    const { engine } = createEngine({
      maxAttempts: 1,
      enrich: async (sku) => {
        calls += 1;
        if (calls === 1) throw new EnrichError("sku invalido", { retryable: false });
        return { sku, price: 9, stock: 4 };
      },
    });
    engine.registerRun({ runId: "run", total: 1, startedAt: "2026-08-03T12:00:00Z" });
    engine.ingest({ runId: "run", seq: 7, sku: "sku-001" });
    await waitFor(() => engine.snapshot().runs[0]?.items[0]?.status === "failed");
    expect(calls).toBe(1);

    engine.ingest({ runId: "run", seq: 7, sku: "sku-001" });
    await waitFor(() => engine.snapshot().runs[0]?.items[0]?.status === "done");
    expect(calls).toBe(2);
    expect(engine.snapshot().runs[0]?.duplicates).toBe(1);
  });

  it("nunca passa de 3 enriquecimentos em voo", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { engine, delivered } = createEngine({
      concurrency: 3,
      enrich: (sku) =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve({ sku, price: 1, stock: 1 });
          }, 30);
        }),
    });

    engine.registerRun({ runId: "run", total: 10, startedAt: "2026-08-03T12:00:00Z" });
    for (let seq = 0; seq < 10; seq += 1) {
      engine.ingest({ runId: "run", seq, sku: `sku-${seq}` });
    }

    await waitFor(() => delivered.length === 1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3);
    expect(delivered[0]?.result).toHaveLength(10);
  });

  it("ordena o resultado por seq e só envia o callback com o lote fechado", async () => {
    const pending = new Map<string, (value: { sku: string; price: number; stock: number }) => void>();
    const { engine, delivered } = createEngine({
      enrich: (sku) =>
        new Promise((resolve) => {
          pending.set(sku, resolve);
        }),
    });

    engine.ingest({ runId: "run", seq: 2, sku: "c" });
    engine.ingest({ runId: "run", seq: 0, sku: "a" });
    pending.get("c")?.({ sku: "c", price: 3, stock: 3 });
    pending.get("a")?.({ sku: "a", price: 1, stock: 1 });
    await waitFor(() => engine.snapshot().runs[0]?.items.every((item) => item.status === "done") === true);
    expect(delivered).toHaveLength(0);

    engine.registerRun({ runId: "run", total: 3, startedAt: "2026-08-03T12:00:00Z" });
    expect(delivered).toHaveLength(0);

    engine.ingest({ runId: "run", seq: 1, sku: "b" });
    pending.get("b")?.({ sku: "b", price: 2, stock: 2 });
    await waitFor(() => delivered.length === 1);
    expect(delivered[0]?.result.map((item) => item.seq)).toEqual([0, 1, 2]);
    expect(delivered[0]?.result.map((item) => item.sku)).toEqual(["a", "b", "c"]);
  });

  it("repete 429 e não repete 404", async () => {
    const calls = new Map<string, number>();
    const { engine, delivered } = createEngine({
      enrich: async (sku) => {
        const next = (calls.get(sku) ?? 0) + 1;
        calls.set(sku, next);
        if (sku === "retry" && next < 3) {
          throw new EnrichError("429", { retryable: true, retryAfterMs: 15 });
        }
        if (sku === "missing") throw new EnrichError("404", { retryable: false });
        return { sku, price: next, stock: next };
      },
    });

    engine.registerRun({ runId: "run", total: 2, startedAt: "2026-08-03T12:00:00Z" });
    engine.ingest({ runId: "run", seq: 0, sku: "retry" });
    engine.ingest({ runId: "run", seq: 1, sku: "missing" });
    await waitFor(() => delivered.length === 1);
    expect(calls.get("retry")).toBe(3);
    expect(calls.get("missing")).toBe(1);
    expect(delivered[0]?.result).toEqual([{ seq: 0, sku: "retry", price: 3, stock: 3 }]);
  });

  it("não reenvia o mesmo resultado e permite reenvio manual", async () => {
    let calls = 0;
    const { engine } = createEngine({
      enrich: async (sku) => ({ sku, price: 10, stock: 2 }),
      deliver: async () => {
        calls += 1;
        return { report: calls };
      },
    });
    engine.registerRun({ runId: "run", total: 1, startedAt: "2026-08-03T12:00:00Z" });
    engine.ingest({ runId: "run", seq: 0, sku: "sku-001" });
    engine.ingest({ runId: "run", seq: 0, sku: "sku-001" });
    await waitFor(() => calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);

    engine.resend("run");
    await waitFor(() => {
      const response = engine.snapshot().runs[0]?.callback.response as { report?: number } | null;
      return response?.report === 2;
    });
    expect(calls).toBe(2);
  });

  it("retoma itens interrompidos sem repetir o callback já enviado", async () => {
    const { engine, delivered } = createEngine({
      enrich: async (sku) => ({ sku, price: 4, stock: 8 }),
    });
    engine.hydrate([
      {
        runId: "run",
        total: 2,
        startedAt: "2026-08-03T12:00:00Z",
        duplicates: 1,
        lastSignature: "0:sku-0:1:1",
        deliverAttempts: 0,
        callback: { status: "sent", response: { ok: true }, error: null, sentAt: "2026-08-03T12:00:01Z" },
        items: [
          {
            seq: 0,
            sku: "sku-0",
            status: "done",
            attempts: 1,
            price: 1,
            stock: 1,
            error: null,
            receivedAt: "2026-08-03T12:00:00Z",
          },
          {
            seq: 1,
            sku: "sku-1",
            status: "processing",
            attempts: 1,
            price: null,
            stock: null,
            error: null,
            receivedAt: "2026-08-03T12:00:00Z",
          },
        ],
      },
    ]);

    await waitFor(() => delivered.length === 1);
    expect(delivered[0]?.result.map((item) => item.seq)).toEqual([0, 1]);
    expect(engine.snapshot().runs[0]?.duplicates).toBe(1);
  });
});
