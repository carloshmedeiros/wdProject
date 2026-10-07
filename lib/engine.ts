import { EnrichError } from "./errors";
import { backoffMs } from "./retry";
import type {
  CallbackResultItem,
  CallbackView,
  Enrichment,
  ItemStatus,
  ItemView,
  LogLevel,
  ProcessMessage,
  RunView,
} from "./types";

export type EngineDeliverInput = {
  run_id: string;
  result: CallbackResultItem[];
};

type Item = {
  seq: number;
  sku: string;
  status: ItemStatus;
  attempts: number;
  price?: number;
  stock?: number;
  error?: string;
  receivedAt: string;
};

type Run = {
  runId: string;
  total: number | null;
  startedAt: string | null;
  items: Map<number, Item>;
  duplicates: number;
  lastSignature: string | null;
  delivering: boolean;
  deliverAttempts: number;
  callback: CallbackView;
};

type Job = {
  runId: string;
  seq: number;
  sku: string;
};

export type EngineSnapshot = {
  runs: RunView[];
  inFlight: number;
  queued: number;
};

export type PersistedRun = {
  runId: string;
  total: number | null;
  startedAt: string | null;
  duplicates: number;
  lastSignature: string | null;
  deliverAttempts: number;
  callback: CallbackView;
  items: ItemView[];
};

type EngineOptions = {
  concurrency: number;
  maxAttempts: number;
  enrich: (sku: string) => Promise<Enrichment>;
  deliver: (payload: EngineDeliverInput) => Promise<unknown>;
  now?: () => Date;
  log?: (level: LogLevel, message: string) => void;
  onChange?: () => void;
};

const EMPTY_CALLBACK: CallbackView = {
  status: "idle",
  response: null,
  error: null,
  sentAt: null,
};

export class BatchEngine {
  private readonly runs = new Map<string, Run>();
  private readonly runOrder: string[] = [];
  private readonly queue: Job[] = [];
  private active = 0;
  private pumping = false;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly enrich: EngineOptions["enrich"];
  private readonly deliverResult: EngineOptions["deliver"];
  private readonly now: () => Date;
  private readonly log?: EngineOptions["log"];
  private readonly onChange?: EngineOptions["onChange"];

  constructor(options: EngineOptions) {
    this.concurrency = options.concurrency;
    this.maxAttempts = options.maxAttempts;
    this.enrich = options.enrich;
    this.deliverResult = options.deliver;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.onChange = options.onChange;
  }

  ingest(message: ProcessMessage): { duplicate: boolean } {
    const run = this.ensureRun(message.runId);
    const existing = run.items.get(message.seq);

    if (existing) {
      run.duplicates += 1;
      this.log?.("info", `Duplicata ignorada ${message.runId}#${message.seq}`);
      if (existing.status === "failed") {
        existing.status = "queued";
        existing.error = undefined;
        existing.attempts = 0;
        this.enqueue({ runId: message.runId, seq: message.seq, sku: existing.sku });
      }
      this.onChange?.();
      return { duplicate: true };
    }

    run.items.set(message.seq, {
      seq: message.seq,
      sku: message.sku,
      status: "queued",
      attempts: 0,
      receivedAt: this.now().toISOString(),
    });
    this.enqueue({ runId: message.runId, seq: message.seq, sku: message.sku });
    this.onChange?.();
    return { duplicate: false };
  }

  registerRun(input: { runId: string; total: number; startedAt: string }) {
    const run = this.ensureRun(input.runId);
    run.total = input.total;
    run.startedAt = input.startedAt;
    this.log?.("info", `Lote ${input.runId} aberto com ${input.total} SKUs`);
    this.onChange?.();
    this.maybeDeliver(run);
  }

  resend(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.lastSignature = null;
    run.deliverAttempts = 0;
    void this.deliver(run, true);
  }

  retryFailed(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const item of run.items.values()) {
      if (item.status !== "failed") continue;
      item.status = "queued";
      item.error = undefined;
      item.attempts = 0;
      this.enqueue({ runId, seq: item.seq, sku: item.sku });
    }
    this.onChange?.();
  }

  snapshot(): EngineSnapshot {
    let queued = 0;
    const runs = [...this.runOrder]
      .reverse()
      .map((runId) => this.toView(this.runs.get(runId)!));
    for (const run of this.runs.values()) {
      for (const item of run.items.values()) {
        if (item.status === "queued") queued += 1;
      }
    }
    return { runs, inFlight: this.active, queued };
  }

  toJSON(): PersistedRun[] {
    return this.runOrder.map((runId) => {
      const run = this.runs.get(runId)!;
      return {
        runId: run.runId,
        total: run.total,
        startedAt: run.startedAt,
        duplicates: run.duplicates,
        lastSignature: run.lastSignature,
        deliverAttempts: run.deliverAttempts,
        callback: run.callback,
        items: [...run.items.values()]
          .sort((a, b) => a.seq - b.seq)
          .map((item) => this.toItemView(item)),
      };
    });
  }

  hydrate(runs: PersistedRun[]) {
    this.runs.clear();
    this.runOrder.length = 0;
    this.queue.length = 0;
    for (const saved of runs) {
      const run = this.blankRun(saved.runId);
      run.total = saved.total;
      run.startedAt = saved.startedAt;
      run.duplicates = saved.duplicates;
      run.lastSignature = saved.lastSignature;
      run.deliverAttempts = saved.deliverAttempts;
      run.callback = saved.callback;
      for (const item of saved.items) {
        const status: ItemStatus =
          item.status === "processing" || item.status === "queued" ? "queued" : item.status;
        run.items.set(item.seq, {
          seq: item.seq,
          sku: item.sku,
          status,
          attempts: item.attempts,
          price: item.price ?? undefined,
          stock: item.stock ?? undefined,
          error: item.error ?? undefined,
          receivedAt: item.receivedAt,
        });
        if (status === "queued") {
          this.queue.push({ runId: run.runId, seq: item.seq, sku: item.sku });
        }
      }
      this.runs.set(run.runId, run);
      this.runOrder.push(run.runId);
    }
    this.pump();
    for (const run of this.runs.values()) this.maybeDeliver(run);
  }

  private ensureRun(runId: string) {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const run = this.blankRun(runId);
    this.runs.set(runId, run);
    this.runOrder.push(runId);
    return run;
  }

  private blankRun(runId: string): Run {
    return {
      runId,
      total: null,
      startedAt: null,
      items: new Map(),
      duplicates: 0,
      lastSignature: null,
      delivering: false,
      deliverAttempts: 0,
      callback: { ...EMPTY_CALLBACK },
    };
  }

  private enqueue(job: Job) {
    this.queue.push(job);
    this.pump();
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.concurrency && this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.active += 1;
        void this.execute(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(job: Job) {
    try {
      await this.work(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro inesperado";
      this.log?.("error", message);
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private async work(job: Job) {
    const run = this.runs.get(job.runId);
    const item = run?.items.get(job.seq);
    if (!run || !item || item.status !== "queued") return;

    item.status = "processing";
    item.attempts += 1;
    this.onChange?.();

    try {
      const enrichment = await this.enrich(job.sku);
      const current = run.items.get(job.seq);
      if (!current || current.status === "done") return;
      current.status = "done";
      current.price = enrichment.price;
      current.stock = enrichment.stock;
      current.error = undefined;
      this.onChange?.();
      this.maybeDeliver(run);
    } catch (error) {
      const current = run.items.get(job.seq);
      if (!current || current.status === "done") return;
      const retryable = !(error instanceof EnrichError) || error.retryable;
      const message = error instanceof Error ? error.message : "falha no enriquecimento";

      if (retryable && current.attempts < this.maxAttempts) {
        const wait =
          error instanceof EnrichError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : backoffMs(current.attempts);
        current.status = "queued";
        current.error = message;
        this.log?.("warn", `Retry ${job.sku} em ${wait}ms (${message})`);
        this.onChange?.();
        setTimeout(() => {
          const latest = run.items.get(job.seq);
          if (!latest || latest.status !== "queued") return;
          this.enqueue(job);
        }, wait);
        return;
      }

      current.status = "failed";
      current.error = message;
      this.log?.("error", `SKU ${job.sku} falhou: ${message}`);
      this.onChange?.();
      this.maybeDeliver(run);
    }
  }

  private isComplete(run: Run) {
    if (run.total === null || run.items.size < run.total) return false;
    for (const item of run.items.values()) {
      if (item.status === "queued" || item.status === "processing") return false;
    }
    return true;
  }

  private resultOf(run: Run): CallbackResultItem[] {
    return [...run.items.values()]
      .filter((item) => item.status === "done" && item.price !== undefined && item.stock !== undefined)
      .sort((a, b) => a.seq - b.seq)
      .map((item) => ({
        seq: item.seq,
        sku: item.sku,
        price: item.price!,
        stock: item.stock!,
      }));
  }

  private signatureOf(result: CallbackResultItem[]) {
    return result.map((item) => `${item.seq}:${item.sku}:${item.price}:${item.stock}`).join("|");
  }

  private maybeDeliver(run: Run) {
    void this.deliver(run, false);
  }

  private async deliver(run: Run, force: boolean) {
    if (run.delivering) return;
    if (!force && !this.isComplete(run)) return;

    const result = this.resultOf(run);
    if (result.length === 0) return;

    const signature = this.signatureOf(result);
    if (run.lastSignature === signature) return;

    run.delivering = true;
    run.callback = { ...run.callback, status: "sending", error: null };
    this.onChange?.();

    try {
      const response = await this.deliverResult({ run_id: run.runId, result });
      run.lastSignature = signature;
      run.deliverAttempts = 0;
      run.callback = {
        status: "sent",
        response,
        error: null,
        sentAt: this.now().toISOString(),
      };
      this.log?.("info", `Callback de ${run.runId} enviado com ${result.length} itens`);
    } catch (error) {
      run.deliverAttempts += 1;
      const message = error instanceof Error ? error.message : "falha no callback";
      run.callback = { ...run.callback, status: "error", error: message };
      this.log?.("error", `Callback de ${run.runId} falhou: ${message}`);
      if (run.deliverAttempts < 5) {
        const delay = backoffMs(run.deliverAttempts);
        setTimeout(() => {
          run.delivering = false;
          void this.deliver(run, force);
        }, delay);
        this.onChange?.();
        return;
      }
    }

    run.delivering = false;
    this.onChange?.();
    if (this.isComplete(run) && this.signatureOf(this.resultOf(run)) !== run.lastSignature) {
      void this.deliver(run, false);
    }
  }

  private toView(run: Run): RunView {
    return {
      runId: run.runId,
      total: run.total,
      startedAt: run.startedAt,
      duplicates: run.duplicates,
      callback: run.callback,
      items: [...run.items.values()].sort((a, b) => a.seq - b.seq).map((item) => this.toItemView(item)),
    };
  }

  private toItemView(item: Item): ItemView {
    return {
      seq: item.seq,
      sku: item.sku,
      status: item.status,
      attempts: item.attempts,
      price: item.price ?? null,
      stock: item.stock ?? null,
      error: item.error ?? null,
      receivedAt: item.receivedAt,
    };
  }
}
