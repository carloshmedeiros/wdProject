import { errorResponse } from "@/lib/http";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getRuntime().getState(), {
    headers: { "cache-control": "no-store" },
  });
}
