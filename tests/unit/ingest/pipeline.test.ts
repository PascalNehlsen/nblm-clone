// C1 ingestion (approved plan, Pascal 2026-10-19; see .git/C1-API-SPEC.md "Pipeline").
// ingestSource(deps, sourceId) takes every store, the pdf extractor and the model caller
// as injected dependencies (IngestDeps) -- the only things NOT injected are the pure
// modules magic.ts, normalize.ts and chunk.ts, which ingestSource calls directly. That
// means this file drives the real chunker through plain, punctuation-free filler text
// whose length is chosen from the documented chunk.ts rules (CHUNK_MAX, CHUNK_OVERLAP,
// CHUNK_MIN_TAIL), not through a fake, wherever an exact chunk count matters.
//
// Math for `textForChunkCount(n)`: with no "\n\n", no ". "/"! "/"? " and no whitespace at
// all in the page text, chunk.ts's cut rule can never find a paragraph break, a sentence
// end or any whitespace in the cut window, so it always falls through to rule 4 (hard cut
// at `start + CHUNK_MAX`); and because there is no whitespace anywhere in the text, the
// "next start" rule's "follows a whitespace character" search also always comes up empty,
// so every next start is the documented fallback `prevEnd - CHUNK_OVERLAP` exactly. That
// makes the stride between consecutive chunk starts exactly `CHUNK_MAX - CHUNK_OVERLAP`
// and every non-final chunk exactly CHUNK_MAX characters long. Choosing the final chunk's
// remaining length as CHUNK_MAX (>= CHUNK_MIN_TAIL, so the tail-merge rule never fires)
// gives, for n chunks, a page of exactly `(n - 1) * (CHUNK_MAX - CHUNK_OVERLAP) + CHUNK_MAX`
// characters -- used below only to pick a chunk *count*, never to predict chunk content
// (predicting exact chunk boundaries is chunk.test.ts's job, not this file's).
import { describe, expect, it, vi } from "vitest";
import type { ModelErrorCategory } from "@/lib/ops/categories";
import type { PdfResult } from "@/lib/server/ingest/pdf";
import type { UrlTextResult } from "@/lib/server/ingest/url-source";
import { ingestSource } from "@/lib/server/ingest/pipeline";
import type { IngestDeps, IngestLogEvent } from "@/lib/server/ingest/pipeline";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import {
  CHUNK_INSERT_BATCH,
  CHUNK_MAX,
  CHUNK_OVERLAP,
  EMBEDDING_DIMENSIONS,
  MAX_CHUNKS_PER_SOURCE,
} from "@/lib/sources/limits";
import type { ChunkRow, ClaimedSource, ObjectStore, SourceStore } from "@/lib/sources/sources";

const DEFAULT_CLAIMED_TEXT: ClaimedSource = {
  id: "source-1",
  notebookId: "notebook-1",
  kind: "text",
  storagePath: "notebook-1/source-1",
  sourceUrl: null,
};

// C2 (URL import, see .git/C2-API-SPEC.md "pipeline.ts changes"): a kind "url" claim carries
// the URL the user gave; the pipeline fetches it only if no object exists yet.
const URL_SOURCE_URL = "https://example.com/artikel";
const DEFAULT_CLAIMED_URL: ClaimedSource = {
  ...DEFAULT_CLAIMED_TEXT,
  kind: "url",
  sourceUrl: URL_SOURCE_URL,
};

const HAPPY_PATH_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Dies ist Testsatz Nummer ${i}, lang genug um über mehrere Chunks verteilt zu werden.`,
).join(" ");

const STRIDE = CHUNK_MAX - CHUNK_OVERLAP;

function textForChunkCount(n: number): string {
  if (n < 1) throw new Error("textForChunkCount: n must be >= 1");
  return "a".repeat((n - 1) * STRIDE + CHUNK_MAX);
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function vectorsFor(n: number): number[][] {
  return Array.from({ length: n }, () => Array<number>(EMBEDDING_DIMENSIONS).fill(0.01));
}

// Wraps any fake implementation (default or test-provided, success or throw) so that every
// call is pushed onto a shared, per-harness order log -- used to pin down the required call
// order (claim, then deleteChunks, then download, ...) without depending on vi.fn's
// internal invocationCallOrder for the simple cases.
function withOrder<Args extends unknown[], R>(
  order: string[],
  label: string,
  impl: (...args: Args) => Promise<R>,
) {
  return vi.fn(async (...args: Args): Promise<R> => {
    order.push(label);
    return impl(...args);
  });
}

interface HarnessOptions {
  claim?: ClaimedSource | null;
  download?: (path: string) => Promise<Uint8Array | null>;
  extractPdf?: (bytes: Uint8Array) => Promise<PdfResult>;
  callModel?: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
  insertChunks?: (rows: ChunkRow[]) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  uploadText?: (path: string, text: string) => Promise<void>;
  fetchUrl?: (url: string) => Promise<UrlTextResult>;
}

function buildHarness(opts: HarnessOptions = {}) {
  const order: string[] = [];

  const claim = withOrder(order, "claim", async (): Promise<ClaimedSource | null> =>
    opts.claim === undefined ? DEFAULT_CLAIMED_TEXT : opts.claim,
  );

  const deleteChunks = withOrder(order, "deleteChunks", async (): Promise<void> => {});
  const markReady = withOrder(order, "markReady", async (): Promise<void> => {});
  const markFailed = withOrder(
    order,
    "markFailed",
    async (): Promise<void> => {},
  );
  const insertChunks = withOrder(
    order,
    "insertChunks",
    opts.insertChunks ?? (async (): Promise<void> => {}),
  );

  const sources: SourceStore = { claim, markReady, markFailed, deleteChunks, insertChunks };

  const download = withOrder(
    order,
    "download",
    opts.download ?? (async (): Promise<Uint8Array | null> => textBytes(HAPPY_PATH_TEXT)),
  );
  const remove = withOrder(order, "remove", opts.remove ?? (async (): Promise<void> => {}));

  const uploadText = withOrder(order, "uploadText", opts.uploadText ?? (async (): Promise<void> => {}));
  const objects: ObjectStore = { download, remove, uploadText };

  const fetchUrl = withOrder(
    order,
    "fetchUrl",
    opts.fetchUrl ?? (async (): Promise<UrlTextResult> => ({ ok: true, text: HAPPY_PATH_TEXT })),
  );

  const extractPdf = withOrder(
    order,
    "extractPdf",
    opts.extractPdf ??
      (async (): Promise<PdfResult> => ({
        ok: true,
        pages: [{ page: 1, text: "Default pdf page text, long enough to form a single chunk." }],
      })),
  );

  const callModel = withOrder(
    order,
    "callModel",
    opts.callModel ??
      (async (req: ModelCallRequest<"embedding">): Promise<ModelCallResult<"embedding">> => ({
        ok: true,
        output: { vectors: vectorsFor(req.input.texts.length) },
        usageId: "usage-1",
        inputTokens: 1,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 1,
        settled: true,
      })),
  );

  const log = vi.fn<(e: IngestLogEvent) => void>(() => {});
  let tick = 0;
  const now = vi.fn((): number => {
    tick += 1;
    return tick * 10;
  });

  const deps: IngestDeps = { sources, objects, extractPdf, callModel, fetchUrl, log, now };

  return {
    deps,
    uploadText,
    fetchUrl,
    order,
    claim,
    markReady,
    markFailed,
    deleteChunks,
    insertChunks,
    download,
    remove,
    extractPdf,
    callModel,
    log,
    now,
  };
}

describe("ingestSource: text happy path", () => {
  it("claims, clears old chunks, downloads, embeds once, inserts chunks, marks ready", async () => {
    const harness = buildHarness();

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(harness.claim).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id);
    expect(harness.order.slice(0, 4)).toEqual(["claim", "deleteChunks", "download", "callModel"]);

    expect(harness.callModel).toHaveBeenCalledTimes(1);
    const req = harness.callModel.mock.calls[0]![0] as ModelCallRequest<"embedding">;
    expect(Object.keys(req).sort()).toEqual(["input", "kind", "notebookId"].sort());
    expect(req.kind).toBe("embedding");
    expect(req.notebookId).toBe(DEFAULT_CLAIMED_TEXT.notebookId);
    const texts = req.input.texts;
    expect(texts.length).toBeGreaterThan(0);

    expect(harness.insertChunks).toHaveBeenCalledTimes(1);
    const rows = harness.insertChunks.mock.calls[0]![0] as ChunkRow[];
    expect(rows.map((r) => r.content)).toEqual(texts);
    expect(rows.map((r) => r.ordinal)).toEqual(texts.map((_, i) => i));
    expect(rows.every((r) => r.notebook_id === DEFAULT_CLAIMED_TEXT.notebookId)).toBe(true);
    expect(rows.every((r) => r.source_id === DEFAULT_CLAIMED_TEXT.id)).toBe(true);
    expect(rows.every((r) => r.page === null)).toBe(true);
    expect(rows.every((r) => r.embedding.length === EMBEDDING_DIMENSIONS)).toBe(true);
    expect(rows.every((r) => r.embedding.every((v) => Number.isFinite(v)))).toBe(true);

    expect(harness.markReady).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id);
    expect(result).toEqual({ ok: true, chunks: texts.length });

    expect(harness.log).toHaveBeenCalledTimes(1);
    const event = harness.log.mock.calls[0]![0] as IngestLogEvent;
    expect(event.outcome).toBe("ready");
    expect(event.category).toBeNull();
    expect(event.kind).toBe("text");
    expect(event.sourceId).toBe(DEFAULT_CLAIMED_TEXT.id);
    expect(event.chunks).toBe(texts.length);
    expect(event.bytes).toBe(textBytes(HAPPY_PATH_TEXT).length);
  });
});

describe("ingestSource: pdf path", () => {
  it("carries each page's number onto its chunks", async () => {
    const harness = buildHarness({
      claim: { ...DEFAULT_CLAIMED_TEXT, kind: "pdf" },
      download: async () => textBytes("%PDF-1.4 fake but validly-tagged pdf bytes"),
      extractPdf: async () => ({
        ok: true,
        pages: [
          { page: 1, text: "Erster Seiteninhalt mit genug Text, um einen Chunk zu bilden." },
          { page: 2, text: "Zweiter Seiteninhalt mit anderem Text für diesen Test." },
        ],
      }),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: true, chunks: 2 });
    const rows = harness.insertChunks.mock.calls[0]![0] as ChunkRow[];
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
    expect(rows.map((r) => r.page)).toEqual([1, 2]);

    expect(harness.log).toHaveBeenCalledTimes(1);
    const event = harness.log.mock.calls[0]![0] as IngestLogEvent;
    expect(event.pages).toBe(2);
    expect(event.chunks).toBe(2);
    expect(event.kind).toBe("pdf");
  });
});

describe("ingestSource: claim fails", () => {
  it("claim returning null skips the source, touching neither storage nor the model", async () => {
    const harness = buildHarness({ claim: null });

    const result = await ingestSource(harness.deps, "source-x");

    expect(result).toEqual({ ok: false, category: "not_claimed" });
    expect(harness.deleteChunks).not.toHaveBeenCalled();
    expect(harness.download).not.toHaveBeenCalled();
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledTimes(1);
    const event = harness.log.mock.calls[0]![0] as IngestLogEvent;
    expect(event.outcome).toBe("skipped");
    expect(event.sourceId).toBe("source-x");
    expect(event.kind).toBeNull();
  });
});

describe("ingestSource: download failures", () => {
  it("download returning null fails with upload_missing", async () => {
    const harness = buildHarness({ download: async () => null });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "upload_missing" });
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "upload_missing");
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("download throwing fails with storage_failed", async () => {
    const harness = buildHarness({
      download: async () => {
        throw new Error("disk is down");
      },
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "storage_failed" });
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "storage_failed");
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledTimes(1);
  });
});

describe("ingestSource: content check and extraction failures", () => {
  it("pdf bytes without the %PDF- magic fail as unsupported_type and the object is removed", async () => {
    const harness = buildHarness({
      claim: { ...DEFAULT_CLAIMED_TEXT, kind: "pdf" },
      download: async () => textBytes("this is not a pdf file at all"),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "unsupported_type" });
    expect(harness.remove).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.storagePath);
    expect(harness.extractPdf).not.toHaveBeenCalled();
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "unsupported_type");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("an encrypted pdf fails with pdf_encrypted and never reaches the model", async () => {
    const harness = buildHarness({
      claim: { ...DEFAULT_CLAIMED_TEXT, kind: "pdf" },
      download: async () => textBytes("%PDF-1.4 looks like a pdf"),
      extractPdf: async () => ({ ok: false, category: "pdf_encrypted" }),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "pdf_encrypted" });
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "pdf_encrypted");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("whitespace-only text normalizes to empty and fails with no_text", async () => {
    const harness = buildHarness({ download: async () => textBytes("   ") });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "no_text" });
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "no_text");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it(
    `more than MAX_CHUNKS_PER_SOURCE (${MAX_CHUNKS_PER_SOURCE}) chunks fails with too_many_chunks, no model call`,
    async () => {
      const harness = buildHarness({
        download: async () => textBytes(textForChunkCount(MAX_CHUNKS_PER_SOURCE + 1)),
      });

      const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

      expect(result).toEqual({ ok: false, category: "too_many_chunks" });
      expect(harness.callModel).not.toHaveBeenCalled();
      expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "too_many_chunks");
      expect(harness.log).toHaveBeenCalledTimes(1);
    },
    20_000,
  );
});

describe("ingestSource: the model refuses", () => {
  interface RefusalCase {
    category: ModelErrorCategory;
  }
  const MODEL_REFUSAL_CASES: RefusalCase[] = [{ category: "budget_exceeded" }, { category: "model_not_configured" }];

  it.each(MODEL_REFUSAL_CASES)(
    "callModel refusing with $category fails the same way, without inserting chunks",
    async ({ category }) => {
      const harness = buildHarness({
        callModel: async () => ({ ok: false, category, usageId: null }),
      });

      const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

      expect(result).toEqual({ ok: false, category });
      expect(harness.insertChunks).not.toHaveBeenCalled();
      expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, category);
      expect(harness.log).toHaveBeenCalledTimes(1);
    },
  );
});

describe("ingestSource: invalid vectors", () => {
  interface InvalidVectorCase {
    name: string;
    makeVectors: (texts: string[]) => number[][];
  }

  const INVALID_VECTOR_CASES: InvalidVectorCase[] = [
    {
      name: "fewer vectors than texts",
      makeVectors: (texts) => vectorsFor(Math.max(0, texts.length - 1)),
    },
    {
      name: "a vector one dimension short of EMBEDDING_DIMENSIONS",
      makeVectors: (texts) => {
        const vectors = vectorsFor(texts.length);
        vectors[0] = vectors[0]!.slice(0, EMBEDDING_DIMENSIONS - 1);
        return vectors;
      },
    },
    {
      name: "a vector containing NaN",
      makeVectors: (texts) => {
        const vectors = vectorsFor(texts.length);
        vectors[0]![0] = Number.NaN;
        return vectors;
      },
    },
  ];

  it.each(INVALID_VECTOR_CASES)("$name -> provider_invalid_response, no chunks inserted", async ({ makeVectors }) => {
    const harness = buildHarness({
      callModel: async (req) => ({
        ok: true,
        output: { vectors: makeVectors(req.input.texts) },
        usageId: "usage-1",
        inputTokens: 1,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 1,
        settled: true,
      }),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "provider_invalid_response" });
    expect(harness.insertChunks).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "provider_invalid_response");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });
});

describe("ingestSource: insertChunks batching", () => {
  it(`inserts 250 chunks in batches of ${CHUNK_INSERT_BATCH}, ${CHUNK_INSERT_BATCH} and 50`, async () => {
    const harness = buildHarness({ download: async () => textBytes(textForChunkCount(250)) });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: true, chunks: 250 });
    expect(harness.insertChunks).toHaveBeenCalledTimes(3);
    const batchSizes = harness.insertChunks.mock.calls.map(([rows]) => (rows as ChunkRow[]).length);
    expect(batchSizes).toEqual([CHUNK_INSERT_BATCH, CHUNK_INSERT_BATCH, 50]);
    const allOrdinals = harness.insertChunks.mock.calls.flatMap(([rows]) => (rows as ChunkRow[]).map((r) => r.ordinal));
    expect(allOrdinals).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(harness.log).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("a batch error with code 54000 maps to notebook_chunk_limit and cleans up with deleteChunks", async () => {
    const harness = buildHarness({
      insertChunks: async () => {
        throw Object.assign(new Error("chunk cap hit"), { code: "54000" });
      },
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "notebook_chunk_limit" });
    expect(harness.deleteChunks).toHaveBeenCalledTimes(2); // the initial clean + the failure cleanup
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "notebook_chunk_limit");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("the third batch throwing an unrecognized Postgres error maps to db_failed and cleans up", async () => {
    let callCount = 0;
    const harness = buildHarness({
      download: async () => textBytes(textForChunkCount(250)),
      insertChunks: async () => {
        callCount += 1;
        if (callCount === 3) throw Object.assign(new Error("db exploded"), { code: "XX000" });
      },
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(result).toEqual({ ok: false, category: "db_failed" });
    expect(harness.insertChunks).toHaveBeenCalledTimes(3);
    expect(harness.deleteChunks).toHaveBeenCalledTimes(2);
    // The cleanup deleteChunks call happens strictly after the failing 3rd insertChunks call.
    const cleanupOrder = harness.deleteChunks.mock.invocationCallOrder[1]!;
    const thirdInsertOrder = harness.insertChunks.mock.invocationCallOrder[2]!;
    expect(cleanupOrder).toBeGreaterThan(thirdInsertOrder);
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_TEXT.id, "db_failed");
    expect(harness.log).toHaveBeenCalledTimes(1);
  }, 20_000);
});

describe("ingestSource: url path (C2)", () => {
  it("a missing object: fetches once, uploads the text, then embeds and marks ready", async () => {
    const harness = buildHarness({
      claim: DEFAULT_CLAIMED_URL,
      download: async () => null,
      fetchUrl: async () => ({ ok: true, text: HAPPY_PATH_TEXT }),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(harness.fetchUrl).toHaveBeenCalledTimes(1);
    expect(harness.fetchUrl).toHaveBeenCalledWith(URL_SOURCE_URL);
    expect(harness.uploadText).toHaveBeenCalledTimes(1);
    expect(harness.uploadText).toHaveBeenCalledWith(DEFAULT_CLAIMED_URL.storagePath, HAPPY_PATH_TEXT);
    expect(harness.order).toEqual([
      "claim",
      "deleteChunks",
      "download",
      "fetchUrl",
      "uploadText",
      "callModel",
      "insertChunks",
      "markReady",
    ]);
    expect(harness.extractPdf).not.toHaveBeenCalled();
    expect(harness.callModel).toHaveBeenCalledTimes(1);
    expect(harness.markReady).toHaveBeenCalledWith(DEFAULT_CLAIMED_URL.id);
    expect(result.ok).toBe(true);

    expect(harness.log).toHaveBeenCalledTimes(1);
    const event = harness.log.mock.calls[0]![0] as IngestLogEvent;
    expect(event.outcome).toBe("ready");
    expect(event.kind).toBe("url");
    expect(event.bytes).toBe(textBytes(HAPPY_PATH_TEXT).length);
  });

  it("an existing object (a retry after a later failure) is reused: no fetch, no upload", async () => {
    const harness = buildHarness({
      claim: DEFAULT_CLAIMED_URL,
      download: async () => textBytes(HAPPY_PATH_TEXT),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(harness.fetchUrl).not.toHaveBeenCalled();
    expect(harness.uploadText).not.toHaveBeenCalled();
    expect(harness.callModel).toHaveBeenCalledTimes(1);
    expect(harness.markReady).toHaveBeenCalledWith(DEFAULT_CLAIMED_URL.id);
    expect(result.ok).toBe(true);
  });

  const FETCH_FAILURES = [
    "url_blocked",
    "url_dns_failed",
    "url_timeout",
    "url_too_large",
    "url_unsupported_type",
    "no_text",
    "too_many_chunks",
  ];
  it.each(FETCH_FAILURES)("a fetch failure with %s fails the source with that category, nothing uploaded", async (category) => {
    const harness = buildHarness({
      claim: DEFAULT_CLAIMED_URL,
      download: async () => null,
      fetchUrl: async () => ({ ok: false, category }),
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(result).toEqual({ ok: false, category });
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_URL.id, category);
    expect(harness.uploadText).not.toHaveBeenCalled();
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.insertChunks).not.toHaveBeenCalled();
    expect(harness.markReady).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledTimes(1);
    const event = harness.log.mock.calls[0]![0] as IngestLogEvent;
    expect(event.outcome).toBe("failed");
    expect(event.category).toBe(category);
    expect(event.kind).toBe("url");
  });

  it("sourceUrl null on a url row without an object fails as url_invalid, without fetching", async () => {
    const harness = buildHarness({
      claim: { ...DEFAULT_CLAIMED_URL, sourceUrl: null },
      download: async () => null,
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(result).toEqual({ ok: false, category: "url_invalid" });
    expect(harness.fetchUrl).not.toHaveBeenCalled();
    expect(harness.uploadText).not.toHaveBeenCalled();
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_URL.id, "url_invalid");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("uploadText throwing fails as storage_failed and never embeds", async () => {
    const harness = buildHarness({
      claim: DEFAULT_CLAIMED_URL,
      download: async () => null,
      uploadText: async () => {
        throw new Error("storage is down");
      },
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(result).toEqual({ ok: false, category: "storage_failed" });
    expect(harness.fetchUrl).toHaveBeenCalledTimes(1);
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(DEFAULT_CLAIMED_URL.id, "storage_failed");
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("a download that throws on a url row fails as storage_failed without fetching", async () => {
    const harness = buildHarness({
      claim: DEFAULT_CLAIMED_URL,
      download: async () => {
        throw new Error("disk is down");
      },
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(result).toEqual({ ok: false, category: "storage_failed" });
    expect(harness.fetchUrl).not.toHaveBeenCalled();
  });

  it("a fetchUrl that throws fails the source (never an unhandled rejection) and the message does not leak", async () => {
    const harness = buildHarness({
      claim: DEFAULT_CLAIMED_URL,
      download: async () => null,
      fetchUrl: async () => {
        throw new Error("boom for host example.com");
      },
    });

    const result = await ingestSource(harness.deps, DEFAULT_CLAIMED_URL.id);

    expect(result.ok).toBe(false);
    expect(harness.markFailed).toHaveBeenCalledTimes(1);
    expect(harness.callModel).not.toHaveBeenCalled();
    expect(JSON.stringify([result, harness.log.mock.calls])).not.toContain("example.com");
  });
});

describe("ingestSource: retry", () => {
  it("deleteChunks runs before download on every call, including a retry of the same source", async () => {
    const harness = buildHarness();

    await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);
    await ingestSource(harness.deps, DEFAULT_CLAIMED_TEXT.id);

    expect(harness.deleteChunks).toHaveBeenCalledTimes(2);
    expect(harness.download).toHaveBeenCalledTimes(2);
    const deleteOrder = harness.deleteChunks.mock.invocationCallOrder;
    const downloadOrder = harness.download.mock.invocationCallOrder;
    expect(deleteOrder[0]!).toBeLessThan(downloadOrder[0]!);
    expect(deleteOrder[1]!).toBeLessThan(downloadOrder[1]!);
    expect(harness.log).toHaveBeenCalledTimes(2);
  });
});
