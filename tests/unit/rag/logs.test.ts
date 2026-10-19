// C3 vector search: "Logs never contain prompt, source or answer text" (AGENTS.md).
// Sentinels are planted in the question and in the chunk content that the fakes return;
// no log event (and no console output, and no result besides the chunks themselves)
// may contain the question sentinel, and no log event may contain the content sentinel.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCallResult } from "@/lib/server/model/call";
import type { MatchRow, RetrievalLogEvent, RetrieverDeps } from "@/lib/rag/retrieve";
import { buildRetriever } from "@/lib/rag/retrieve";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/server/model/embeddings", () => ({
  createEmbeddingCaller: vi.fn(() => vi.fn()),
}));

const NOTEBOOK_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_QUESTION = "sentinel-question-text-4e8a1";
const SECRET_CONTENT = "sentinel-chunk-content-7c3d9";
const SECRET_ERROR = "sentinel-thrown-error-2b6f0";

// Exactly the keys of RetrievalLogEvent in the spec.
const EXPECTED_LOG_KEYS = ["dropped", "event", "k", "ms", "outcome", "reason", "returned", "topScore"];

const vec = (): number[] => Array<number>(1024).fill(0.01);

const okEmbed = async (): Promise<ModelCallResult<"embedding">> => ({
  ok: true,
  output: { vectors: [vec()] },
  usageId: "usage-1",
  inputTokens: 1,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 1,
  settled: true,
});

const rows = async (): Promise<MatchRow[]> => [
  { id: "c1", source_id: "s1", ordinal: 0, content: `Text ${SECRET_CONTENT}`, page: 1, similarity: 0.8 },
  { id: "c2", source_id: "s1", ordinal: 1, content: `Mehr ${SECRET_CONTENT}`, page: null, similarity: -0.3 },
];

function run(over: Partial<RetrieverDeps>, notebookId = NOTEBOOK_ID, question = `Frage: ${SECRET_QUESTION}`) {
  const log = vi.fn<(e: RetrievalLogEvent) => void>();
  const deps: RetrieverDeps = {
    embed: okEmbed,
    notebookVisible: async () => true,
    matchChunks: rows,
    log,
    now: () => 0,
    ...over,
  };
  return { log, result: buildRetriever(deps)(notebookId, question) };
}

function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
}

function serialize(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Error ? { message: v.message, stack: v.stack, cause: v.cause } : v,
    ) ?? ""
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const paths: Array<[string, Partial<RetrieverDeps>, string?]> = [
  ["success", {}],
  ["success with zero rows", { matchChunks: async () => [] }],
  ["invalid notebook id", {}, "not-a-uuid"],
  ["not visible", { notebookVisible: async () => false }],
  [
    "notebookVisible throws",
    {
      notebookVisible: async () => {
        throw new Error(`db: ${SECRET_ERROR} ${SECRET_QUESTION}`);
      },
    },
  ],
  ["embed refusal", { embed: async () => ({ ok: false, category: "budget_exceeded", usageId: null }) }],
  [
    "embed returns a bad vector",
    { embed: async () => ({ ...(await okEmbed()), output: { vectors: [[Number.NaN]] } }) as ModelCallResult<"embedding"> },
  ],
  [
    "matchChunks throws",
    {
      matchChunks: async () => {
        throw new Error(`rpc: ${SECRET_ERROR} ${SECRET_CONTENT}`);
      },
    },
  ],
];

describe("retrieval logs: no question or chunk text, fixed keys", () => {
  it.each(paths)("%s", async (_name, over, notebookId) => {
    const consoleSpies = spyOnConsole();
    const { log, result } = run(over, notebookId);
    await result;

    expect(log).toHaveBeenCalledTimes(1);
    const event = log.mock.calls[0]?.[0] as RetrievalLogEvent;
    expect(Object.keys(event).sort()).toEqual(EXPECTED_LOG_KEYS);

    const text = serialize(log.mock.calls);
    for (const sentinel of [SECRET_QUESTION, SECRET_CONTENT, SECRET_ERROR]) {
      expect(text).not.toContain(sentinel);
      for (const spy of consoleSpies) expect(serialize(spy.mock.calls)).not.toContain(sentinel);
    }
  });

  it("a failure result does not carry the thrown error text either", async () => {
    const { result } = run({
      matchChunks: async () => {
        throw new Error(`rpc: ${SECRET_ERROR}`);
      },
    });
    expect(serialize(await result)).not.toContain(SECRET_ERROR);
  });
});
