import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { runId?: unknown };
  try {
    body = (await request.json()) as { runId?: unknown };
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (typeof body.runId !== "string" || body.runId.length === 0) {
    return Response.json({ error: "Informe o run_id." }, { status: 400 });
  }
  getRuntime().retryFailed(body.runId);
  return Response.json({ ok: true });
}
