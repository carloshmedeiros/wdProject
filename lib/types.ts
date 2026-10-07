export type Credentials = {
  name: string;
  webhook: string;
  cid: string;
  token: string;
};

export type ItemStatus = "queued" | "processing" | "done" | "failed";

export type ItemView = {
  seq: number;
  sku: string;
  status: ItemStatus;
  attempts: number;
  price: number | null;
  stock: number | null;
  error: string | null;
  receivedAt: string;
};

export type CallbackStatus = "idle" | "sending" | "sent" | "error";

export type CallbackView = {
  status: CallbackStatus;
  response: unknown;
  error: string | null;
  sentAt: string | null;
};

export type RunView = {
  runId: string;
  total: number | null;
  startedAt: string | null;
  duplicates: number;
  items: ItemView[];
  callback: CallbackView;
};

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  at: string;
  level: LogLevel;
  message: string;
};

export type PublicState = {
  credentials: Credentials | null;
  runs: RunView[];
  inFlight: number;
  queued: number;
  ack: { count: number; avgMs: number; maxMs: number };
  logs: LogEntry[];
  config: { baseUrl: string; concurrency: number; maxAttempts: number };
};

export type ProcessMessage = {
  runId: string;
  seq: number;
  sku: string;
};

export type Enrichment = {
  sku: string;
  price: number;
  stock: number;
};

export type CallbackResultItem = {
  seq: number;
  sku: string;
  price: number;
  stock: number;
};

export type CallbackPayload = {
  cid: string;
  run_id: string;
  result: CallbackResultItem[];
};
