import { getRuntime } from "@/lib/runtime";
import { parseProcessBody } from "@/lib/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const started = performance.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const message = parseProcessBody(body);
  if (!message) {
    return Response.json({ ok: false }, { status: 400 });
  }

  const app = getRuntime();
  app.ingest(message);
  app.recordAck(performance.now() - started);
  return Response.json({ ok: true }, { status: 202 });
}
