// C1 ingestion (approved plan, Pascal 2026-10-19; see .git/C1-API-SPEC.md "Pipeline" and
// AGENTS.md: "Logs never contain prompt, source or answer text"). ingestSource(deps, sourceId)
// is fully dependency-injected (see pipeline.test.ts), so sentinels planted in the fake
// download/extractPdf/callModel/insertChunks implementations below are genuinely data the
// pipeline touches -- this file checks none of it ever reaches deps.log, console output or
// the returned IngestOutcome.
//
// Same sentinel-leak technique as tests/unit/model/call.test.ts's "no sentinel text leaks
// anywhere besides the returned output" describe block.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfResult } from "@/lib/server/ingest/pdf";
import type { UrlTextResult } from "@/lib/server/ingest/url-source";
import { ingestSource } from "@/lib/server/ingest/pipeline";
import type { IngestDeps, IngestLogEvent } from "@/lib/server/ingest/pipeline";
import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import { EMBEDDING_DIMENSIONS } from "@/lib/sources/limits";
import type { ChunkRow, ClaimedSource, ObjectStore, SourceStore } from "@/lib/sources/sources";

// run.ts wires the real production model-call wrapper (lib/server/model/call.ts), whose
// import chain reaches lib/server/model/caller.ts -> @/lib/supabase/server (next/headers'
// cookies()) and lib/server/model/embeddings.ts (the real Bedrock provider). Both are
// mocked here so that importing run.ts for the jsonIngestLog tests below never touches a
// real request context, a real provider, or the admin usage store.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
  })),
}));
vi.mock("@/lib/server/model/call", () => ({
  createModelCaller: vi.fn(() => vi.fn(async () => ({ ok: false, category: "unauthenticated", usageId: null }))),
}));

const SECRET_TEXT = "sentinel-source-text-9f21a";
// Stands in for "title-like data": ingestSource(deps, sourceId) has no title parameter at
// all (titles live only in the sources table, read by the server actions, never by the
// pipeline), so there is no literal way to pass a title into it. storagePath is the closest
// identifying string the pipeline genuinely receives from claim() that IngestLogEvent has
// no field for, so it is used here as the same class of leak the plan calls out.
const SECRET_TITLE = "sentinel-title-like-storage-path-3b7c2";
const SECRET_PDF_PAGE = "sentinel-pdf-page-text-5d4e1";
const SECRET_CALLMODEL_ERROR = "sentinel-callmodel-error-7a6b3";
const SECRET_INSERT_ERROR = "sentinel-insertchunks-error-1c9f4";
const SECRET_DOWNLOAD_ERROR = "sentinel-download-error-8e2d5";

// C2: a URL import touches three more kinds of data the log must never carry: the URL
// the user chose, its host, and the fetched page text (see AGENTS.md: "Logs never
// contain prompt, source or answer text"; the plan: IngestLogEvent has no URL field).
const SECRET_URL_HOST = "sentinel-host-4k8m2.example.net";
const SECRET_URL = `https://${SECRET_URL_HOST}/pfad/sentinel-path-6q1w9?token=sentinel-query-2z7x5`;
const SECRET_PAGE_TEXT = "sentinel-page-text-8r3t6";
const SECRET_FETCH_ERROR = "sentinel-fetch-error-0p5v1";
const SECRET_UPLOAD_ERROR = "sentinel-upload-error-9c2b8";

const ALL_SENTINELS = [
  SECRET_URL_HOST,
  SECRET_URL,
  "sentinel-path-6q1w9",
  "sentinel-query-2z7x5",
  SECRET_PAGE_TEXT,
  SECRET_FETCH_ERROR,
  SECRET_UPLOAD_ERROR,
  SECRET_TEXT,
  SECRET_TITLE,
  SECRET_PDF_PAGE,
  SECRET_CALLMODEL_ERROR,
  SECRET_INSERT_ERROR,
  SECRET_DOWNLOAD_ERROR,
];

const ALLOWED_LOG_KEYS = ["event", "outcome", "category", "kind", "sourceId", "bytes", "pages", "chunks", "ms"];

function assertNoSentinel(haystack: unknown): void {
  const text = JSON.stringify(haystack, (_key, value: unknown) =>
    value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value,
  );
  for (const sentinel of ALL_SENTINELS) {
    expect(text ?? "").not.toContain(sentinel);
  }
}

function assertLogKeysSubset(log: { mock: { calls: unknown[][] } }): void {
  expect(log.mock.calls.length).toBeGreaterThan(0);
  for (const call of log.mock.calls) {
    const event = call[0] as Record<string, unknown>;
    expect(Object.keys(event).every((key) => ALLOWED_LOG_KEYS.includes(key))).toBe(true);
  }
}

function vectorsFor(n: number): number[][] {
  return Array.from({ length: n }, () => Array<number>(EMBEDDING_DIMENSIONS).fill(0.01));
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface LeakHarnessOptions {
  claim?: ClaimedSource | null;
  download?: (path: string) => Promise<Uint8Array | null>;
  extractPdf?: (bytes: Uint8Array) => Promise<PdfResult>;
  callModel?: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
  insertChunks?: (rows: ChunkRow[]) => Promise<void>;
  fetchUrl?: (url: string) => Promise<UrlTextResult>;
  uploadText?: (path: string, text: string) => Promise<void>;
}

function buildLeakHarness(opts: LeakHarnessOptions): { deps: IngestDeps; log: { mock: { calls: unknown[][] } } } {
  const claimed: ClaimedSource | null =
    opts.claim === undefined
      ? {
          id: "source-1",
          notebookId: "notebook-1",
          kind: "text",
          storagePath: `notebook-1/${SECRET_TITLE}`,
          sourceUrl: null,
        }
      : opts.claim;

  const sources: SourceStore = {
    claim: vi.fn(async (): Promise<ClaimedSource | null> => claimed),
    markReady: vi.fn(async (): Promise<void> => {}),
    markFailed: vi.fn(async (): Promise<void> => {}),
    deleteChunks: vi.fn(async (): Promise<void> => {}),
    insertChunks: vi.fn(opts.insertChunks ?? (async (): Promise<void> => {})),
  };

  const objects: ObjectStore = {
    download: vi.fn(opts.download ?? (async () => textBytes(`Satz mit Geheimnis ${SECRET_TEXT}.`))),
    remove: vi.fn(async (): Promise<void> => {}),
    uploadText: vi.fn(opts.uploadText ?? (async (): Promise<void> => {})),
  };

  const fetchUrl = vi.fn(
    opts.fetchUrl ?? (async (): Promise<UrlTextResult> => ({ ok: true, text: `Seite mit ${SECRET_PAGE_TEXT}.` })),
  );

  const extractPdf = vi.fn(
    opts.extractPdf ??
      (async (): Promise<PdfResult> => ({
        ok: true,
        pages: [{ page: 1, text: `Seite mit Geheimnis ${SECRET_PDF_PAGE}.` }],
      })),
  );

  const callModel = vi.fn(
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

  const log = vi.fn((): void => {});
  const now = vi.fn((): number => 0);

  return { deps: { sources, objects, extractPdf, callModel, fetchUrl, log, now }, log };
}

function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestSource: no sentinel leaks on success", () => {
  it("text success: source text and storagePath sentinels stay out of logs, console and the outcome", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({});

    const result = await ingestSource(deps, "source-1");

    expect(result.ok).toBe(true);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("pdf success: pdf page text and storagePath sentinels stay out of logs, console and the outcome", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      claim: {
        id: "source-2",
        notebookId: "notebook-1",
        kind: "pdf",
        storagePath: `notebook-1/${SECRET_TITLE}`,
        sourceUrl: null,
      },
      download: async () => textBytes("%PDF-1.4 valid-looking pdf bytes"),
    });

    const result = await ingestSource(deps, "source-2");

    expect(result.ok).toBe(true);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });
});

describe("ingestSource: no sentinel leaks on failure", () => {
  it("a download error's message never leaks", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      download: async () => {
        throw new Error(`disk failure: ${SECRET_DOWNLOAD_ERROR}`);
      },
    });

    const result = await ingestSource(deps, "source-1");

    expect(result.ok).toBe(false);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("a callModel error's message never leaks", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      callModel: async () => {
        throw new Error(`provider blew up: ${SECRET_CALLMODEL_ERROR}`);
      },
    });

    const result = await ingestSource(deps, "source-1");

    expect(result.ok).toBe(false);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("an insertChunks error's message never leaks", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      insertChunks: async () => {
        throw Object.assign(new Error(`insert blew up: ${SECRET_INSERT_ERROR}`), { code: "XX000" });
      },
    });

    const result = await ingestSource(deps, "source-1");

    expect(result.ok).toBe(false);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });
});

describe("ingestSource: url paths never log the URL, host or page text (C2)", () => {
  const URL_CLAIM: ClaimedSource = {
    id: "source-3",
    notebookId: "notebook-1",
    kind: "url",
    storagePath: `notebook-1/${SECRET_TITLE}`,
    sourceUrl: SECRET_URL,
  };

  it("success with a fresh fetch: the URL, host and page text stay out of logs, console and the outcome", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({ claim: URL_CLAIM, download: async () => null });

    const result = await ingestSource(deps, "source-3");

    expect(result.ok).toBe(true);
    expect(deps.fetchUrl).toHaveBeenCalledWith(SECRET_URL);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("success on a retry (object exists): nothing leaks either", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      claim: URL_CLAIM,
      download: async () => textBytes(`Gespeicherte Seite ${SECRET_PAGE_TEXT}.`),
    });

    const result = await ingestSource(deps, "source-3");

    expect(result.ok).toBe(true);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("a fetch failure result: only the fixed category is logged", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      claim: URL_CLAIM,
      download: async () => null,
      fetchUrl: async () => ({ ok: false, category: "url_blocked" }),
    });

    const result = await ingestSource(deps, "source-3");

    expect(result).toEqual({ ok: false, category: "url_blocked" });
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("a fetchUrl error whose message carries the URL and host never leaks", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      claim: URL_CLAIM,
      download: async () => null,
      fetchUrl: async () => {
        throw new Error(`connect failed to ${SECRET_URL} (${SECRET_URL_HOST}): ${SECRET_FETCH_ERROR}`);
      },
    });

    const result = await ingestSource(deps, "source-3");

    expect(result.ok).toBe(false);
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("an uploadText error whose message carries page text never leaks", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      claim: URL_CLAIM,
      download: async () => null,
      uploadText: async () => {
        throw new Error(`upload failed for ${SECRET_PAGE_TEXT} ${SECRET_UPLOAD_ERROR}`);
      },
    });

    const result = await ingestSource(deps, "source-3");

    expect(result).toEqual({ ok: false, category: "storage_failed" });
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertNoSentinel(result);
    assertLogKeysSubset(log);
  });

  it("a missing sourceUrl fails as url_invalid without leaking anything", async () => {
    const consoleSpies = spyOnConsole();
    const { deps, log } = buildLeakHarness({
      claim: { ...URL_CLAIM, sourceUrl: null },
      download: async () => null,
    });

    const result = await ingestSource(deps, "source-3");

    expect(result).toEqual({ ok: false, category: "url_invalid" });
    assertNoSentinel(log.mock.calls);
    for (const spy of consoleSpies) assertNoSentinel(spy.mock.calls);
    assertLogKeysSubset(log);
  });
});

describe("jsonIngestLog (lib/server/ingest/run)", () => {
  it("writes exactly one console.info call with parseable JSON", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { jsonIngestLog } = await import("@/lib/server/ingest/run");
    const event: IngestLogEvent = {
      event: "ingest",
      outcome: "ready",
      category: null,
      kind: "text",
      sourceId: "source-1",
      bytes: 10,
      pages: null,
      chunks: 2,
      ms: 5,
    };

    jsonIngestLog(event);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [line] = infoSpy.mock.calls[0] as [string];
    expect(typeof line).toBe("string");
    expect(() => JSON.parse(line)).not.toThrow();
  });
});
