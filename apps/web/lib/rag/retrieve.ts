import "server-only";

import { isUuid } from "@/lib/notebooks/roles";
import type { ModelErrorCategory } from "@/lib/ops/categories";
import { normalizeText } from "@/lib/server/ingest/normalize";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import { createEmbeddingCaller } from "@/lib/server/model/embeddings";
import { EMBEDDING_DIMENSIONS } from "@/lib/sources/limits";
import { createClient } from "@/lib/supabase/server";
import { MAX_QUESTION_CHARS, MIN_SCORE, RETRIEVAL_K } from "./limits";

// Vector search for one question in one notebook (C3), for the chat in block D. Everything
// runs with the user's login: the membership pre-check keeps strangers from spending budget,
// and match_chunks is security invoker, so RLS on chunks decides again (ADR 0004).

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  ordinal: number;
  page: number | null;
  content: string;
  score: number;
}

export interface MatchRow {
  id: string;
  source_id: string;
  ordinal: number;
  content: string;
  page: number | null;
  similarity: number;
}

export type RetrievalReason =
  | "invalid_input"
  | "not_found"
  | "provider_invalid_response"
  | "db_failed"
  | ModelErrorCategory;

export type RetrievalResult =
  | { ok: true; chunks: RetrievedChunk[]; usageId: string }
  | { ok: false; reason: RetrievalReason };

export interface RetrievalLogEvent {
  event: "retrieval";
  outcome: "ok" | "failed";
  reason: RetrievalReason | null;
  k: number;
  returned: number | null;
  dropped: number | null;
  topScore: number | null;
  ms: number;
}

export interface RetrieverDeps {
  embed: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
  notebookVisible: (notebookId: string) => Promise<boolean>;
  matchChunks: (embedding: number[], notebookId: string, k: number) => Promise<MatchRow[]>;
  log: (e: RetrievalLogEvent) => void;
  now: () => number;
  minScore?: number;
}

function validVector(vectors: unknown): number[] | null {
  if (!Array.isArray(vectors) || vectors.length !== 1) return null;
  const v: unknown = vectors[0];
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) return null;
  return v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : null;
}

export function buildRetriever(deps: RetrieverDeps): (notebookId: string, question: string) => Promise<RetrievalResult> {
  const minScore = deps.minScore ?? MIN_SCORE;

  return async (notebookId, question) => {
    const startedAt = deps.now();
    const stats = { returned: null as number | null, dropped: null as number | null, topScore: null as number | null };
    const finish = (result: RetrievalResult): RetrievalResult => {
      deps.log({
        event: "retrieval",
        outcome: result.ok ? "ok" : "failed",
        reason: result.ok ? null : result.reason,
        k: RETRIEVAL_K,
        ...stats,
        ms: Math.max(0, Math.round(deps.now() - startedAt)),
      });
      return result;
    };
    const fail = (reason: RetrievalReason) => finish({ ok: false, reason });

    if (!isUuid(notebookId)) return fail("invalid_input");
    const text = typeof question === "string" ? normalizeText(question).trim() : "";
    if (text.length === 0 || text.length > MAX_QUESTION_CHARS) return fail("invalid_input");

    try {
      if (!(await deps.notebookVisible(notebookId))) return fail("not_found");
    } catch {
      return fail("db_failed");
    }

    const embedded = await deps.embed({ kind: "embedding", notebookId, input: { texts: [text] } });
    if (!embedded.ok) return fail(embedded.category);
    const vector = validVector(embedded.output?.vectors);
    if (!vector) return fail("provider_invalid_response");

    let rows: MatchRow[];
    try {
      rows = await deps.matchChunks(vector, notebookId, RETRIEVAL_K);
    } catch {
      return fail("db_failed");
    }
    const kept = rows.filter((r) => r.similarity >= minScore);
    stats.returned = rows.length;
    stats.dropped = rows.length - kept.length;
    stats.topScore = rows.length > 0 ? Math.max(...rows.map((r) => r.similarity)) : null;

    return finish({
      ok: true,
      usageId: embedded.usageId,
      chunks: kept.map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        ordinal: r.ordinal,
        page: r.page,
        content: r.content,
        score: r.similarity,
      })),
    });
  };
}

// The production wiring: the user's own Supabase client and the budgeted embedding caller.
export async function retrieve(notebookId: string, question: string): Promise<RetrievalResult> {
  const supabase = await createClient();
  return buildRetriever({
    embed: createEmbeddingCaller(),
    notebookVisible: async (id) => {
      const { data, error } = await supabase.from("notebooks").select("id").eq("id", id).maybeSingle();
      if (error) throw new Error("notebook lookup failed");
      return data !== null;
    },
    matchChunks: async (embedding, id, k) => {
      const { data, error } = await supabase.rpc("match_chunks", {
        query_embedding: embedding,
        p_notebook_id: id,
        match_count: k,
      });
      if (error) throw new Error("match_chunks failed");
      return (data ?? []) as MatchRow[];
    },
    log: (e) => console.info(JSON.stringify(e)),
    now: () => performance.now(),
  })(notebookId, question);
}
