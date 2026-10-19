import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { CanaryResult } from "./canary";

// The canary route's logic (ADR 0014): off (404) unless configured, POST only, a secret
// header compared in constant time, no request body read, booleans out.

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

export async function handleCanaryRequest(
  request: Request,
  deps: { secret: string | undefined; run: () => Promise<CanaryResult> | null },
): Promise<Response> {
  const secret = deps.secret?.trim() ?? "";
  if (secret === "") return empty(404);
  if (request.method !== "POST") return empty(405);
  if (!sameSecret(request.headers.get("x-canary-secret") ?? "", secret)) return empty(401);
  const running = deps.run();
  if (running === null) return empty(404);
  const result = await running;
  return Response.json({ ok: result.ok, checks: result.checks }, { status: 200, headers: { "cache-control": "no-store" } });
}
