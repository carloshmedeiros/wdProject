/// <reference path="../types/jsx.d.ts" />
/// <reference path="../types/react-module.d.ts" />
"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicState, RunView } from "@/lib/types";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const statusLabel: Record<string, string> = {
  queued: "na fila",
  processing: "consultando",
  done: "pronto",
  failed: "falhou",
  idle: "aguardando",
  sending: "enviando",
  sent: "enviado",
  error: "erro",
};

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; runId?: string };
  if (!response.ok) throw new Error(data.error || "A operação falhou.");
  return data;
}

function batchIsOpen(data: PublicState) {
  if (data.inFlight > 0 || data.queued > 0) return true;
  return data.runs.some((run) => {
    if (run.callback.status === "sending") return true;
    if (run.items.some((item) => item.status === "queued" || item.status === "processing")) return true;
    return run.total !== null && run.items.length < run.total && run.callback.status !== "sent";
  });
}

export function Dashboard() {
  const [state, setState] = useState<PublicState | null>(null);
  const [name, setName] = useState("");
  const [webhook, setWebhook] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<string>("");
  const [watch, setWatch] = useState(0);
  const seeded = useRef(false);

  const loadState = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    const data = (await response.json()) as PublicState;
    setState(data);
    if (!seeded.current) {
      seeded.current = true;
      if (data.credentials) {
        setName(data.credentials.name);
        setWebhook(data.credentials.webhook);
      }
    }
    return data;
  }, []);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      try {
        const data = await loadState();
        if (stop || !batchIsOpen(data)) return;
        timer = setTimeout(() => void loop(), 1000);
      } catch {
        if (!stop) setError("Não foi possível ler o estado do serviço.");
      }
    };

    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [loadState, watch]);

  const run = state?.runs.find((item) => item.runId === selected) ?? state?.runs[0] ?? null;

  async function onRegister(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending("register");
    try {
      await postJson("/api/register", { name, webhook });
      setWatch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha no registro.");
    } finally {
      setPending("");
    }
  }

  async function onBurst() {
    setError("");
    setPending("burst");
    try {
      const opened = await postJson("/api/burst");
      if (opened.runId) setSelected(opened.runId);
      setWatch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao solicitar o lote.");
    } finally {
      setPending("");
    }
  }

  async function onResend() {
    if (!run) return;
    setError("");
    setPending("callback");
    try {
      await postJson("/api/callback", { runId: run.runId });
      setWatch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao reenviar.");
    } finally {
      setPending("");
    }
  }

  async function onRetry() {
    if (!run) return;
    setError("");
    setPending("retry");
    try {
      await postJson("/api/retry", { runId: run.runId });
      setWatch((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao reprocessar.");
    } finally {
      setPending("");
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
  }

  return (
    <main className="app">
      <header className="top">
        <div>
          <p className="logo">
            weduu
          </p>
          <h1>Processamento de lotes de SKU</h1>
          <p className="lede">
            O recebimento responde na hora. Preço e estoque são consultados depois, com no máximo três chamadas ao mesmo tempo, e o lote consolidado volta no callback.
          </p>
        </div>
        <div className="sla">
          <span>SLA de ACK</span>
          <strong>600 ms</strong>
          <span>concorrência do enriquecimento: {state?.config.concurrency ?? 3}</span>
        </div>
      </header>

      {error ? <div className="banner">{error}</div> : null}

      <section className="grid">
        <form className="panel" onSubmit={onRegister}>
          <h2>1. Registrar webhook</h2>
          <p>Use a URL HTTPS do ngrok, sem /check no final. A plataforma valida o serviço durante este registro.</p>
          <div className="form">
            <label>
              Nome
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Seu nome" required />
            </label>
            <label>
              Webhook
              <input
                value={webhook}
                onChange={(event) => setWebhook(event.target.value)}
                placeholder="https://xxxx.ngrok.app"
                required
              />
            </label>
            <button type="submit" disabled={pending === "register"}>
              {pending === "register" ? "Registrando..." : "Registrar"}
            </button>
          </div>
          {state?.credentials ? <Credentials credentials={state.credentials} onCopy={copy} /> : null}
        </form>

        <section className="panel">
          <h2>2. Solicitar lote</h2>
          <p>Cada execução gera um run_id novo e cerca de 20 mensagens em /process.</p>
          <div className="actions">
            <button type="button" onClick={() => void onBurst()} disabled={!state?.credentials || pending === "burst"}>
              {pending === "burst" ? "Solicitando..." : "Solicitar lote"}
            </button>
            <p className="hint">Plataforma: {state?.config.baseUrl ?? "carregando..."}</p>
            <p className="hint">
              ACK local médio: {formatMs(state?.ack.avgMs ?? 0)} · máximo {formatMs(state?.ack.maxMs ?? 0)} · {state?.ack.count ?? 0} respostas
            </p>
          </div>
        </section>
      </section>

      <Metrics run={run} inFlight={state?.inFlight ?? 0} queued={state?.queued ?? 0} />

      <section className="panel stack">
        <div className="section-head">
          <h2>Lote</h2>
          {state && state.runs.length > 1 ? (
            <select value={run?.runId ?? ""} onChange={(event) => setSelected(event.target.value)} aria-label="Lote">
              {state.runs.map((item) => (
                <option key={item.runId} value={item.runId}>
                  {item.runId}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {run ? <RunPanel run={run} pending={pending} onResend={() => void onResend()} onRetry={() => void onRetry()} /> : <p className="empty">Nenhum lote ainda.</p>}
      </section>

      <section className="panel stack">
        <h2>Eventos</h2>
        {state && state.logs.length > 0 ? (
          <ul className="logs">
            {state.logs.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <time>{entry.at.slice(11, 19)}</time>
                <em>{entry.level}</em>
                <span>{entry.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Os eventos da execução aparecem aqui.</p>
        )}
      </section>
    </main>
  );
}

function Credentials({
  credentials,
  onCopy,
}: {
  credentials: NonNullable<PublicState["credentials"]>;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <div className="creds">
      <div className="cred">
        <span>
          cid <strong className="mono">{credentials.cid}</strong>
        </span>
        <button type="button" onClick={() => void onCopy(credentials.cid)}>
          Copiar
        </button>
      </div>
      <div className="cred">
        <span>
          token <strong className="mono">{credentials.token}</strong>
        </span>
        <button type="button" onClick={() => void onCopy(credentials.token)}>
          Copiar
        </button>
      </div>
    </div>
  );
}

function Metrics({ run, inFlight, queued }: { run: RunView | null; inFlight: number; queued: number }) {
  const unique = run?.items.length ?? 0;
  const done = run?.items.filter((item) => item.status === "done").length ?? 0;
  const failed = run?.items.filter((item) => item.status === "failed").length ?? 0;
  return (
    <section className="metrics" aria-label="Resumo do lote">
      <article className="metric">
        <span>Únicos / total</span>
        <strong>
          {unique}/{run?.total ?? "–"}
        </strong>
      </article>
      <article className="metric">
        <span>Prontos</span>
        <strong>{done}</strong>
      </article>
      <article className="metric">
        <span>Duplicatas</span>
        <strong>{run?.duplicates ?? 0}</strong>
      </article>
      <article className="metric">
        <span>Em voo / fila / falhas</span>
        <strong>
          {inFlight} / {queued} / {failed}
        </strong>
      </article>
    </section>
  );
}

function RunPanel({
  run,
  pending,
  onResend,
  onRetry,
}: {
  run: RunView;
  pending: string;
  onResend: () => void;
  onRetry: () => void;
}) {
  const failed = run.items.some((item) => item.status === "failed");
  return (
    <>
      <p className="hint">
        run_id <span className="mono">{run.runId}</span>
        {run.startedAt ? ` · início ${run.startedAt}` : ""} · callback {statusLabel[run.callback.status]}
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={onResend} disabled={pending === "callback" || run.items.every((item) => item.status !== "done")}>
          Reenviar callback
        </button>
        <button type="button" className="secondary" onClick={onRetry} disabled={!failed || pending === "retry"}>
          Reprocessar falhas
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>seq</th>
              <th>SKU</th>
              <th>status</th>
              <th>tentativas</th>
              <th>preço</th>
              <th>estoque</th>
            </tr>
          </thead>
          <tbody>
            {run.items.map((item) => (
              <tr key={item.seq}>
                <td>{item.seq}</td>
                <td className="mono">{item.sku}</td>
                <td>
                  <span className={`pill ${item.status}`}>{statusLabel[item.status]}</span>
                </td>
                <td>{item.attempts}</td>
                <td>{item.price === null ? "–" : money.format(item.price)}</td>
                <td>{item.stock ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {run.callback.error ? <p className="banner">{run.callback.error}</p> : null}
      <h2>Resposta do callback</h2>
      <pre>{JSON.stringify(run.callback.response ?? { status: run.callback.status }, null, 2)}</pre>
    </>
  );
}

function formatMs(value: number) {
  if (!Number.isFinite(value) || value === 0) return "0 ms";
  return `${value.toFixed(1)} ms`;
}
