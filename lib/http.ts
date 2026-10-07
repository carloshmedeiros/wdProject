import { PlatformError } from "@/lib/errors";

export function errorResponse(error: unknown) {
  if (error instanceof PlatformError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    return Response.json({ error: error.message }, { status });
  }
  const message = error instanceof Error ? error.message : "Erro interno";
  return Response.json({ error: message }, { status: 500 });
}
