const DEFAULT_BASE_URL =
  "https://dev-wdu-ped-test-1014944555984.us-central1.run.app";

export type AppConfig = {
  baseUrl: string;
  concurrency: number;
  maxAttempts: number;
};

function clampInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function getConfig(): AppConfig {
  const rawBase = process.env.PLATFORM_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return {
    baseUrl: rawBase.replace(/\/+$/, ""),
    concurrency: clampInt(process.env.ENRICH_CONCURRENCY, 3, 1, 3),
    maxAttempts: clampInt(process.env.ENRICH_MAX_ATTEMPTS, 8, 1, 20),
  };
}
