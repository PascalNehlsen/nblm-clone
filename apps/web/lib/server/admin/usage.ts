import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ReserveArgs, ReserveOutcome, SettleArgs } from "@/lib/server/model/types";

// The only module that holds the service_role key (ADR 0006). It exports only reserve and
// settle, and only lib/server/model/call.ts may import it (eslint.config.mjs). The key is
// not set in Vercel Preview, so every call there fails closed. Errors carry fixed messages:
// never the key, an RPC detail or a response body.

class UsageUnavailable extends Error {
  constructor(reason: string) {
    super(`usage store unavailable: ${reason}`);
    this.name = "UsageUnavailable";
  }
}

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

// Allowlist: a secret key ("sb_secret_...") or a legacy JWT with the service_role role.
function isSecretKey(key: string): boolean {
  return key.startsWith("sb_secret_") || jwtRole(key) === "service_role";
}

let client: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new UsageUnavailable("not configured");
  if (!isSecretKey(key)) throw new UsageUnavailable("SUPABASE_SECRET_KEY is not a secret key");
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // Resolved per request, not at module load.
    global: { fetch: (...args) => fetch(...args) },
  });
  return client;
}

const REFUSALS = new Set(["kill_switch_on", "budget_exceeded", "global_budget_exceeded"]);

// One RPC per reservation: each PostgREST request is its own read committed transaction,
// which the advisory lock in reserve_model_call relies on.
export async function reserve(a: ReserveArgs): Promise<ReserveOutcome> {
  const supabase = adminClient();
  let data: unknown;
  try {
    const result = await supabase.rpc("reserve_model_call", {
      p_user_id: a.userId,
      p_is_anonymous: a.isAnonymous,
      p_notebook_id: a.notebookId,
      p_kind: a.kind,
      p_model_id: a.modelId,
      p_estimated_cost_usd: a.estimatedCostUsd,
      p_call_count: a.callCount,
    });
    if (result.error) throw new UsageUnavailable("reserve failed");
    data = result.data;
  } catch {
    throw new UsageUnavailable("reserve failed");
  }

  const row: unknown = Array.isArray(data) && data.length === 1 ? data[0] : null;
  if (!row || typeof row !== "object") throw new UsageUnavailable("unexpected reserve result");
  const { outcome, usage_id: usageId } = row as { outcome?: unknown; usage_id?: unknown };
  if (outcome === "ok" && typeof usageId === "string" && usageId) return { outcome: "ok", usageId };
  if (typeof outcome === "string" && REFUSALS.has(outcome)) {
    return { outcome: outcome as "kill_switch_on" | "budget_exceeded" | "global_budget_exceeded" };
  }
  throw new UsageUnavailable("unexpected reserve result");
}

// "fail" is settle with status failed. Returns false when the row was no longer reserved.
export async function settle(a: SettleArgs): Promise<boolean> {
  const supabase = adminClient();
  let data: unknown;
  try {
    const result = await supabase.rpc("settle_model_call", {
      p_usage_id: a.usageId,
      p_status: a.status,
      p_input_tokens: a.inputTokens,
      p_output_tokens: a.outputTokens,
      p_cost_usd: a.costUsd,
      p_latency_ms: a.latencyMs,
      p_message_id: a.messageId,
      p_error_category: a.errorCategory,
    });
    if (result.error) throw new UsageUnavailable("settle failed");
    data = result.data;
  } catch {
    throw new UsageUnavailable("settle failed");
  }
  if (typeof data !== "boolean") throw new UsageUnavailable("unexpected settle result");
  return data;
}
