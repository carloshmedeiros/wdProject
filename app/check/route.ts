import { parseCheckBody } from "@/lib/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }

  const token = parseCheckBody(body);
  if (!token) {
    return Response.json({ error: "token ausente" }, { status: 400 });
  }

  return Response.json({ token });
}
