// C3 vector search (plan .git/PLAN_c3-search.md, API spec .git/C3-API-SPEC.md).
// buildRetriever is fully dependency-injected, so every case below uses plain fakes.
// The production retrieve() wiring needs a real session and is not tested here.
import { describe, expect, it, vi } from "vitest";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import type { MatchRow, RetrievalLogEvent, RetrieverDeps } from "@/lib/rag/retrieve";
import { buildRetriever } from "@/lib/rag/retrieve";
import { MAX_QUESTION_CHARS, MIN_SCORE, RETRIEVAL_K } from "@/lib/rag/limits";

// retrieve.ts also exports the production retrieve(), which reaches the request-scoped
// Supabase client and the real embedding caller; neither may load in a unit test.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/server/model/embeddings", () => ({
  createEmbeddingCaller: vi.fn(() => vi.fn()),
}));

const NOTEBOOK_ID = "11111111-1111-4111-8111-111111111111";
const DIMS = 1024;

function vector(fill = 0.01): number[] {
  return Array<number>(DIMS).fill(fill);
}

function okEmbedding(vectors: number[][] = [vector()], usageId = "usage-1"): ModelCallResult<"embedding"> {
  return {
    ok: true,
    output: { vectors },
    usageId,
    inputTokens: 3,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 1,
    settled: true,
  };
}

function row(n: number, similarity: number, page: number | null = null): MatchRow {
  return {
    id: `chunk-${n}`,
    source_id: `source-${n}`,
    ordinal: n,
    content: `content ${n}`,
    page,
    similarity,
  };
}

interface Harness {
  deps: RetrieverDeps;
  embed: ReturnType<typeof vi.fn>;
  notebookVisible: ReturnType<typeof vi.fn>;
  matchChunks: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof buildRetriever>;
}

function harness(
  over: {
    embed?: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
    notebookVisible?: (id: string) => Promise<boolean>;
    matchChunks?: (e: number[], id: string, k: number) => Promise<MatchRow[]>;
    minScore?: number;
  } = {},
): Harness {
  const embed = vi.fn(over.embed ?? (async () => okEmbedding()));
  const notebookVisible = vi.fn(over.notebookVisible ?? (async () => true));
  const matchChunks = vi.fn(over.matchChunks ?? (async () => [row(1, 0.9)]));
  const log = vi.fn<(e: RetrievalLogEvent) => void>();
  const deps: RetrieverDeps = { embed, notebookVisible, matchChunks, log, now: () => 0 };
  if (over.minScore !== undefined) deps.minScore = over.minScore;
  return { deps, embed, notebookVisible, matchChunks, log, retrieve: buildRetriever(deps) };
}

describe("limits", () => {
  it("exports the constants from the spec", () => {
    expect(RETRIEVAL_K).toBe(8);
    expect(MAX_QUESTION_CHARS).toBe(2000);
    expect(MIN_SCORE).toBe(0);
  });
});

describe("buildRetriever: input validation", () => {
  it.each(["", "not-a-uuid", "11111111-1111-4111-8111-11111111111", `${NOTEBOOK_ID}x`])(
    "invalid notebook id %j -> invalid_input, nothing else called",
    async (id) => {
      const h = harness();
      const result = await h.retrieve(id, "Was steht drin?");
      expect(result).toEqual({ ok: false, reason: "invalid_input" });
      expect(h.notebookVisible).not.toHaveBeenCalled();
      expect(h.embed).not.toHaveBeenCalled();
      expect(h.matchChunks).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["empty", ""],
    ["spaces only", "   "],
    ["whitespace and newlines only", " \n\t \n "],
    ["over the limit", "a".repeat(MAX_QUESTION_CHARS + 1)],
  ])("question %s -> invalid_input, nothing else called", async (_name, question) => {
    const h = harness();
    const result = await h.retrieve(NOTEBOOK_ID, question);
    expect(result).toEqual({ ok: false, reason: "invalid_input" });
    expect(h.notebookVisible).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.matchChunks).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("a question of exactly MAX_QUESTION_CHARS is accepted", async () => {
    const h = harness();
    const result = await h.retrieve(NOTEBOOK_ID, "a".repeat(MAX_QUESTION_CHARS));
    expect(result.ok).toBe(true);
    expect(h.embed).toHaveBeenCalledTimes(1);
  });
});

describe("buildRetriever: membership pre-check", () => {
  it("not visible -> not_found, embed and matchChunks not called", async () => {
    const h = harness({ notebookVisible: async () => false });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(h.notebookVisible).toHaveBeenCalledWith(NOTEBOOK_ID);
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.matchChunks).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("notebookVisible throws -> db_failed, embed and matchChunks not called", async () => {
    const h = harness({
      notebookVisible: async () => {
        throw new Error("db down");
      },
    });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result).toEqual({ ok: false, reason: "db_failed" });
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.matchChunks).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
  });
});

describe("buildRetriever: the embedding call", () => {
  it("calls embed once with kind embedding, the notebook id and the normalized question as the only text", async () => {
    const h = harness();
    // CRLF becomes LF, trailing spaces on a line go, outer whitespace is trimmed.
    await h.retrieve(NOTEBOOK_ID, "  Erste Zeile   \r\nZweite Zeile \n ");
    expect(h.embed).toHaveBeenCalledTimes(1);
    const req = h.embed.mock.calls[0]?.[0] as ModelCallRequest<"embedding">;
    expect(req.kind).toBe("embedding");
    expect(req.notebookId).toBe(NOTEBOOK_ID);
    expect(req.input).toEqual({ texts: ["Erste Zeile\nZweite Zeile"] });
  });

  it.each(["kill_switch_on", "budget_exceeded", "unauthenticated"] as const)(
    "refusal %s passes through as the reason, matchChunks not called",
    async (category) => {
      const h = harness({ embed: async () => ({ ok: false, category, usageId: null }) });
      const result = await h.retrieve(NOTEBOOK_ID, "Frage");
      expect(result).toEqual({ ok: false, reason: category });
      expect(h.matchChunks).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledTimes(1);
    },
  );
});

describe("buildRetriever: output check", () => {
  const bad: Array<[string, ModelCallResult<"embedding">]> = [
    ["wrong dimension (1023)", okEmbedding([Array<number>(1023).fill(0.1)])],
    ["wrong dimension (1025)", okEmbedding([Array<number>(1025).fill(0.1)])],
    ["NaN component", okEmbedding([[...vector().slice(0, 1023), Number.NaN]])],
    ["Infinity component", okEmbedding([[...vector().slice(0, 1023), Number.POSITIVE_INFINITY]])],
    ["two vectors", okEmbedding([vector(), vector()])],
    ["zero vectors", okEmbedding([])],
    [
      "missing vectors",
      { ...okEmbedding(), output: {} } as unknown as ModelCallResult<"embedding">,
    ],
  ];

  it.each(bad)("%s -> provider_invalid_response, matchChunks not called", async (_name, embedResult) => {
    const h = harness({ embed: async () => embedResult });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result).toEqual({ ok: false, reason: "provider_invalid_response" });
    expect(h.matchChunks).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
  });
});

describe("buildRetriever: matching", () => {
  it("passes the same vector, the notebook id and RETRIEVAL_K (8) to matchChunks", async () => {
    const v = vector(0.25);
    const h = harness({ embed: async () => okEmbedding([v]) });
    await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(h.matchChunks).toHaveBeenCalledTimes(1);
    const [vec, id, k] = h.matchChunks.mock.calls[0] as [number[], string, number];
    expect(vec).toEqual(v);
    expect(id).toBe(NOTEBOOK_ID);
    expect(k).toBe(8);
  });

  it("maps rows to camelCase chunks exactly, score = similarity, and returns the usageId", async () => {
    const h = harness({
      embed: async () => okEmbedding([vector()], "usage-42"),
      matchChunks: async () => [row(1, 0.91, 3), row(2, 0.5, null)],
    });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result).toEqual({
      ok: true,
      usageId: "usage-42",
      chunks: [
        { id: "chunk-1", sourceId: "source-1", ordinal: 1, page: 3, content: "content 1", score: 0.91 },
        { id: "chunk-2", sourceId: "source-2", ordinal: 2, page: null, content: "content 2", score: 0.5 },
      ],
    });
  });

  it("keeps the database order even when scores are not descending", async () => {
    const h = harness({ matchChunks: async () => [row(1, 0.2), row(2, 0.9), row(3, 0.5)] });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result.ok && result.chunks.map((c) => c.id)).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
  });

  it("default minScore is 0: negative similarity is dropped, 0 and above is kept", async () => {
    const h = harness({ matchChunks: async () => [row(1, 0.3), row(2, 0), row(3, -0.01), row(4, -0.5)] });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result.ok && result.chunks.map((c) => c.id)).toEqual(["chunk-1", "chunk-2"]);
  });

  it("an explicit minScore drops rows below it and keeps rows equal to it", async () => {
    const h = harness({
      minScore: 0.5,
      matchChunks: async () => [row(1, 0.9), row(2, 0.5), row(3, 0.49), row(4, 0.1)],
    });
    const result = await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(result.ok && result.chunks.map((c) => c.id)).toEqual(["chunk-1", "chunk-2"]);
  });

  it("all rows below minScore is still ok with an empty list and the usageId", async () => {
    const h = harness({
      minScore: 0.8,
      embed: async () => okEmbedding([vector()], "usage-7"),
      matchChunks: async () => [row(1, 0.3), row(2, 0.2)],
    });
    expect(await h.retrieve(NOTEBOOK_ID, "Frage")).toEqual({ ok: true, chunks: [], usageId: "usage-7" });
  });

  it("matchChunks throws -> db_failed", async () => {
    const h = harness({
      matchChunks: async () => {
        throw new Error("rpc failed");
      },
    });
    expect(await h.retrieve(NOTEBOOK_ID, "Frage")).toEqual({ ok: false, reason: "db_failed" });
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("zero rows -> ok with [] and the usageId", async () => {
    const h = harness({
      embed: async () => okEmbedding([vector()], "usage-9"),
      matchChunks: async () => [],
    });
    expect(await h.retrieve(NOTEBOOK_ID, "Frage")).toEqual({ ok: true, chunks: [], usageId: "usage-9" });
  });
});

describe("buildRetriever: exactly one log call per retrieval", () => {
  it("success logs one ok event with k, returned, dropped and topScore", async () => {
    const h = harness({ matchChunks: async () => [row(1, 0.9), row(2, 0.4), row(3, -0.2)] });
    await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(h.log).toHaveBeenCalledTimes(1);
    const event = h.log.mock.calls[0]?.[0] as RetrievalLogEvent;
    expect(event.event).toBe("retrieval");
    expect(event.outcome).toBe("ok");
    expect(event.reason).toBeNull();
    expect(event.k).toBe(8);
    expect(event.returned).toBe(3);
    expect(event.dropped).toBe(1);
    expect(event.topScore).toBe(0.9);
    expect(typeof event.ms).toBe("number");
  });

  it("zero rows logs returned 0, dropped 0 and a null topScore", async () => {
    const h = harness({ matchChunks: async () => [] });
    await h.retrieve(NOTEBOOK_ID, "Frage");
    const event = h.log.mock.calls[0]?.[0] as RetrievalLogEvent;
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(event.outcome).toBe("ok");
    expect(event.returned).toBe(0);
    expect(event.dropped).toBe(0);
    expect(event.topScore).toBeNull();
  });

  it("a failure logs one failed event carrying the reason", async () => {
    const h = harness({ notebookVisible: async () => false });
    await h.retrieve(NOTEBOOK_ID, "Frage");
    expect(h.log).toHaveBeenCalledTimes(1);
    const event = h.log.mock.calls[0]?.[0] as RetrievalLogEvent;
    expect(event.event).toBe("retrieval");
    expect(event.outcome).toBe("failed");
    expect(event.reason).toBe("not_found");
  });
});
