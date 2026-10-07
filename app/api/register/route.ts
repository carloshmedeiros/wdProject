import { errorResponse } from "@/lib/http";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { name?: unknown; webhook?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; webhook?: unknown };
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (typeof body.name !== "string" || typeof body.webhook !== "string") {
    return Response.json({ error: "Informe nome e webhook." }, { status: 400 });
  }

  try {
    const credentials = await getRuntime().register(body.name, body.webhook);
    return Response.json(credentials);
  } catch (error) {
    return errorResponse(error);
  }
}
