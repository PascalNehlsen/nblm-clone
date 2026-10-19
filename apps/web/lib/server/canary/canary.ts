import "server-only";

import { randomUUID } from "node:crypto";
import { newNonce } from "@/lib/rag/prompt";
import { runTurn } from "@/lib/server/chat/turn";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import { EMBEDDING_DIMENSIONS } from "@/lib/sources/limits";
import { CANARY_CHUNKS, CANARY_QUESTION } from "./fixture";

// One end-to-end check of a staged deployment before promote (ADR 0014): a real embedding
// and a real chat answer through the budgeted wrapper, checked by the same citation rules
// as the app. Logs and results carry booleans and a fixed reason only, never text.

export interface CanaryChecks {
  embedding: boolean;
  answered: boolean;
  citationValid: boolean;
  notAbstained: boolean;
}

export type CanaryResult = { ok: boolean; checks: CanaryChecks };

export interface CanaryDeps {
  embed: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
  callChat: (req: ModelCallRequest<"chat">) => Promise<ModelCallResult<"chat">>;
  log: (e: { event: "canary"; ok: boolean; checks: CanaryChecks; reason: string | null; ms: number }) => void;
  now: () => number;
}

const CANARY_NOTEBOOK_ID = "00000000-0000-0000-0000-000000000000";

function oneVector(output: unknown): boolean {
  const vectors = (output as { vectors?: unknown } | undefined)?.vectors;
  if (!Array.isArray(vectors) || vectors.length !== 1) return false;
  const v: unknown = vectors[0];
  return Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export async function runCanary(deps: CanaryDeps): Promise<CanaryResult> {
  const startedAt = deps.now();
  const checks: CanaryChecks = { embedding: false, answered: false, citationValid: false, notAbstained: false };
  const finish = (reason: string | null): CanaryResult => {
    const ok = checks.embedding && checks.answered && checks.citationValid && checks.notAbstained;
    deps.log({ event: "canary", ok, checks: { ...checks }, reason: ok ? null : reason, ms: Math.max(0, Math.round(deps.now() - startedAt)) });
    return { ok, checks };
  };

  const embedded = await deps.embed({ kind: "embedding", notebookId: null, input: { texts: [CANARY_QUESTION] } });
  if (!embedded.ok) return finish(embedded.category);
  if (!oneVector(embedded.output)) return finish("invalid_vector");
  checks.embedding = true;

  const turn = await runTurn(
    {
      retrieve: async () => ({ ok: true, chunks: CANARY_CHUNKS, usageId: "canary" }),
      callChat: deps.callChat,
      store: { saveTurn: async () => undefined },
      log: () => undefined,
      now: deps.now,
      nonce: newNonce,
      newId: randomUUID,
    },
    { notebookId: CANARY_NOTEBOOK_ID, question: CANARY_QUESTION },
  );
  if (!turn.ok) return finish(turn.reason);
  checks.answered = true;

  const { citations, abstained } = turn.message;
  checks.notAbstained = !abstained;
  checks.citationValid =
    citations.length > 0 &&
    citations.every((c) => {
      const chunk = CANARY_CHUNKS.find((k) => k.id === c.chunkId);
      return chunk !== undefined && chunk.content.includes(c.quote);
    });
  return finish(checks.notAbstained ? (checks.citationValid ? null : "citation_invalid") : "abstained");
}
