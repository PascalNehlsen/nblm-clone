import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { buildChatInput } from "@/lib/rag/prompt";
import type { RetrievedChunk } from "@/lib/rag/retrieve";
import { runTurn, type TurnResult } from "@/lib/server/chat/turn";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import { EVAL_CASES, QUALITY_FIXTURES, chunksFor } from "./corpus";
import { scoreAbstention, scoreFact, scoreSecurity, type TurnOutcome } from "./score";

// Live eval run (ADR 0017): every case of tests/eval/cases.json gets one real chat turn over
// its fixture chunks, without retrieval and without database writes besides the usage rows
// the budgeted caller books. Only booleans per case come back; no text is logged.

export interface EvalResult {
  cases: Record<string, boolean>;
  errored: number;
}

export interface EvalLogEvent {
  event: "eval";
  passed: number;
  total: number;
  errored: number;
  ms: number;
}

export interface EvalDeps {
  callChat: (req: ModelCallRequest<"chat">) => Promise<ModelCallResult<"chat">>;
  log: (e: EvalLogEvent) => void;
  now: () => number;
}

export const EVAL_CONCURRENCY = 3;

const NOTEBOOK_ID = "00000000-0000-0000-0000-000000000000";

interface Job {
  id: string;
  question: string;
  chunks: RetrievedChunk[];
  score: (o: TurnOutcome, nonce: string, systemPromptFirstLine: string) => boolean;
}

function jobs(): Job[] {
  const quality = chunksFor(QUALITY_FIXTURES);
  return [
    ...EVAL_CASES.facts.map((c) => ({ id: c.id, question: c.question, chunks: quality, score: (o: TurnOutcome) => scoreFact(c, o, quality) })),
    ...EVAL_CASES.abstention.map((c) => ({ id: c.id, question: c.question, chunks: quality, score: (o: TurnOutcome) => scoreAbstention(o) })),
    ...EVAL_CASES.security.map((c) => {
      const chunks = chunksFor([c.fixture]);
      return {
        id: c.id,
        question: c.question,
        chunks,
        score: (o: TurnOutcome, nonce: string, systemPromptFirstLine: string) =>
          scoreSecurity(c, o, chunks, { nonce, systemPromptFirstLine }),
      };
    }),
  ];
}

async function turn(deps: EvalDeps, job: Job, nonce: string, onRaw: (text: string) => void): Promise<TurnResult> {
  return runTurn(
    {
      retrieve: async () => ({ ok: true, chunks: job.chunks, usageId: "eval" }),
      // Like the canary: no notebook and no saved message to book the usage against.
      callChat: (req) =>
        deps.callChat({
          ...req,
          notebookId: null,
          linkMessage: req.linkMessage
            ? async (output) => {
                onRaw(output.text);
                await req.linkMessage!(output);
                return null;
              }
            : undefined,
        }),
      store: { saveTurn: async () => undefined },
      log: () => undefined,
      now: deps.now,
      nonce: () => nonce,
      newId: randomUUID,
    },
    { notebookId: NOTEBOOK_ID, question: job.question },
  );
}

export async function runEval(deps: EvalDeps): Promise<EvalResult> {
  const startedAt = deps.now();
  const all = jobs();
  const cases: Record<string, boolean> = {};
  let errored = 0;
  let next = 0;

  const worker = async () => {
    while (next < all.length) {
      const job = all[next++]!;
      const nonce = randomBytes(8).toString("hex");
      const firstLine = buildChatInput(job.question, job.chunks, nonce).system.split("\n")[0] ?? "";
      let outcome: TurnOutcome = { ok: false };
      let raw = "";
      try {
        const result = await turn(deps, job, nonce, (text) => {
          raw = text;
        });
        if (result.ok) {
          outcome = {
            ok: true,
            content: result.message.content,
            raw,
            abstained: result.message.abstained,
            citations: result.message.citations.map((c) => ({ chunkId: c.chunkId, quote: c.quote })),
          };
        }
      } catch {
        outcome = { ok: false };
      }
      if (!outcome.ok) errored++;
      cases[job.id] = outcome.ok ? job.score(outcome, nonce, firstLine) : false;
    }
  };
  await Promise.all(Array.from({ length: Math.min(EVAL_CONCURRENCY, all.length) }, worker));

  const passed = Object.values(cases).filter(Boolean).length;
  deps.log({ event: "eval", passed, total: all.length, errored, ms: Math.max(0, Math.round(deps.now() - startedAt)) });
  return { cases, errored };
}
