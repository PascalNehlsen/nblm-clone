import "server-only";

// The ops page's database access (ADR 0023): the third module that holds the service_role key,
// next to the usage module (ADR 0006) and the accounts module (ADR 0021). It calls exactly two
// aggregate RPCs, which only service_role may execute. Only lib/server/ops/read.ts and
// lib/server/eval/record.ts may import it (eslint.config.mjs). Same key rules as usage.ts: a
// secret key or a service_role JWT, fail closed before any request, fixed error messages.

function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload && typeof payload === "object" && "role" in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === "string" ? role : null;
    }
    return null;
  } catch {
    return null;
  }
}

function isSecretKey(key: string): boolean {
  return key.startsWith("sb_secret_") || jwtRole(key) === "service_role";
}

async function rpc(name: "ops_summary" | "record_eval_run", args: Record<string, unknown>): Promise<unknown> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !isSecretKey(key)) throw new Error("ops store unavailable: not configured");
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error(`ops store: ${name} failed`);
  }
  if (!response.ok) throw new Error(`ops store: ${name} failed`);
  if (response.status === 204) return null;
  const text = await response.text();
  try {
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    throw new Error(`ops store: ${name} failed`);
  }
}

// The aggregate summary for the last 7 or 30 Berlin days, unparsed (lib/server/ops/summary.ts).
export async function readOpsSummary(days: 7 | 30): Promise<unknown> {
  if (days !== 7 && days !== 30) throw new Error("ops store: days must be 7 or 30");
  const result = await rpc("ops_summary", { p_days: days });
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("ops store: ops_summary failed");
  }
  return result;
}

export interface EvalScore {
  commitSha: string | null;
  securityPassed: number;
  securityTotal: number;
  qualityPassed: number;
  qualityTotal: number;
  errored: number;
  ok: boolean;
}

// One live eval run's score (develop only, ADR 0017). Counts only, never case ids or reasons.
export async function recordEvalRun(score: EvalScore): Promise<void> {
  await rpc("record_eval_run", {
    p_commit_sha: score.commitSha,
    p_security_passed: score.securityPassed,
    p_security_total: score.securityTotal,
    p_quality_passed: score.qualityPassed,
    p_quality_total: score.qualityTotal,
    p_errored: score.errored,
    p_ok: score.ok,
  });
}
