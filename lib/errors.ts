export class EnrichError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "EnrichError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class PlatformError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.body = body;
  }
}
