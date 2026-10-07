import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "./config";
import { EnrichError, PlatformError } from "./errors";
import { BatchEngine, type EngineDeliverInput, type PersistedRun } from "./engine";
import { enrichSku, registerWebhook, requestBurst, sendCallback } from "./platform";
import { normalizeWebhook } from "./parse";
import type { Credentials, LogEntry, LogLevel, ProcessMessage, PublicState } from "./types";

type PersistedState = {
  credentials: Credentials | null;
  ack: { count: number; sumMs: number; maxMs: number };
  runs: PersistedRun[];
};

const STATE_PATH = join(process.cwd(), ".data", "state.json");
const REPORTS_PATH = join(process.cwd(), "reports");

export class AppRuntime {
  readonly engine: BatchEngine;
  credentials: Credentials | null = null;
  logs: LogEntry[] = [];
  private ack = { count: 0, sumMs: 0, maxMs: 0 };
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly config = getConfig();

  constructor() {
    this.engine = new BatchEngine({
      concurrency: this.config.concurrency,
      maxAttempts: this.config.maxAttempts,
      enrich: (sku) => this.enrich(sku),
      deliver: (payload) => this.deliver(payload),
      log: (level, message) => this.pushLog(level, message),
      onChange: () => this.touch(),
    });
    this.restore();
  }

  getState(): PublicState {
    const snapshot = this.engine.snapshot();
    return {
      credentials: this.credentials,
      runs: snapshot.runs,
      inFlight: snapshot.inFlight,
      queued: snapshot.queued,
      ack: {
        count: this.ack.count,
        avgMs: this.ack.count === 0 ? 0 : this.ack.sumMs / this.ack.count,
        maxMs: this.ack.maxMs,
      },
      logs: [...this.logs].reverse().slice(0, 40),
      config: {
        baseUrl: this.config.baseUrl,
        concurrency: this.config.concurrency,
        maxAttempts: this.config.maxAttempts,
      },
    };
  }

  ingest(message: ProcessMessage) {
    return this.engine.ingest(message);
  }

  recordAck(elapsedMs: number) {
    this.ack.count += 1;
    this.ack.sumMs += elapsedMs;
    this.ack.maxMs = Math.max(this.ack.maxMs, elapsedMs);
    this.touch();
  }

  async register(name: string, webhook: string) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new PlatformError("Informe o nome usado no registro.", 400, null);
    }
    const normalized = normalizeWebhook(webhook);
    if (!normalized) {
      throw new PlatformError("Informe a URL HTTPS pública do ngrok, sem caminho. Exemplo: https://xxxx.ngrok.app", 400, null);
    }

    const issued = await registerWebhook(this.config.baseUrl, trimmedName, normalized);
    this.credentials = { name: trimmedName, webhook: normalized, cid: issued.cid, token: issued.token };
    this.pushLog("info", `Webhook registrado para ${trimmedName}.`);
    this.touch();
    return this.credentials;
  }

  async burst() {
    const credentials = this.requireCredentials();
    const opened = await requestBurst(this.config.baseUrl, credentials.cid, credentials.token);
    this.engine.registerRun(opened);
    return opened;
  }

  resend(runId: string) {
    this.engine.resend(runId);
  }

  retryFailed(runId: string) {
    this.engine.retryFailed(runId);
  }

  private requireCredentials() {
    if (!this.credentials) {
      throw new PlatformError("Registre o webhook antes de continuar.", 400, null);
    }
    return this.credentials;
  }

  private enrich(sku: string) {
    const credentials = this.credentials;
    if (!credentials) {
      throw new EnrichError("credenciais ainda não disponíveis", { retryable: true, retryAfterMs: 300 });
    }
    return enrichSku(this.config.baseUrl, credentials.cid, credentials.token, sku);
  }

  private async deliver(payload: EngineDeliverInput) {
    const credentials = this.requireCredentials();
    const body = { cid: credentials.cid, run_id: payload.run_id, result: payload.result };
    const response = await sendCallback(this.config.baseUrl, credentials.token, body);
    await this.writeReport(payload.run_id, body, response);
    return response;
  }

  private async writeReport(runId: string, request: unknown, response: unknown) {
    try {
      await mkdir(REPORTS_PATH, { recursive: true });
      const document = {
        at: new Date().toISOString(),
        request,
        response,
      };
      const json = JSON.stringify(document, null, 2);
      await writeFile(join(REPORTS_PATH, `${runId}.json`), json);
      await writeFile(join(REPORTS_PATH, "latest.json"), json);
    } catch (error) {
      const message = error instanceof Error ? error.message : "falha ao gravar relatório";
      this.pushLog("warn", message);
    }
  }

  private pushLog(level: LogLevel, message: string) {
    this.logs.push({ at: new Date().toISOString(), level, message });
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
  }

  private touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 80);
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const payload: PersistedState = {
      credentials: this.credentials,
      ack: this.ack,
      runs: this.engine.toJSON(),
    };
    const json = JSON.stringify(payload);
    this.writing = this.writing
      .then(async () => {
        await mkdir(join(process.cwd(), ".data"), { recursive: true });
        await writeFile(STATE_PATH, json);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "falha ao persistir estado";
        this.pushLog("error", message);
      });
  }

  private restore() {
    try {
      const raw = readFileSync(STATE_PATH, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      this.credentials = parsed.credentials ?? null;
      if (parsed.ack) this.ack = parsed.ack;
      if (Array.isArray(parsed.runs) && parsed.runs.length > 0) {
        this.engine.hydrate(parsed.runs);
        this.pushLog("info", "Estado anterior restaurado.");
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      this.pushLog("warn", "Não foi possível ler o estado salvo. Um novo estado foi iniciado.");
    }
  }
}

function isMissingFile(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const GLOBAL_KEY = "__provaWeduuRuntime";

export function getRuntime(): AppRuntime {
  const globalState = globalThis as typeof globalThis & { [GLOBAL_KEY]?: AppRuntime };
  if (!globalState[GLOBAL_KEY]) globalState[GLOBAL_KEY] = new AppRuntime();
  return globalState[GLOBAL_KEY];
}
