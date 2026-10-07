import { errorResponse } from "@/lib/http";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const burst = await getRuntime().burst();
    return Response.json(burst);
  } catch (error) {
    return errorResponse(error);
  }
}
