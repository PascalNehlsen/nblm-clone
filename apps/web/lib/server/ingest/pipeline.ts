import "server-only";

import type { ModelCallRequest, ModelCallResult } from "@/lib/server/model/call";
import { CHUNK_INSERT_BATCH, EMBEDDING_DIMENSIONS, MAX_CHUNKS_PER_SOURCE } from "@/lib/sources/limits";
import type { ChunkRow, ObjectStore, SourceKind, SourceStore } from "@/lib/sources/sources";
import { chunkPages, type PageText } from "./chunk";
import { checkContent } from "./magic";
import { normalizeText } from "./normalize";
import type { PdfResult } from "./pdf";

// One source from its stored object to embedded chunks (ADR 0007): claim, check the
// bytes, extract, chunk, one budgeted embedding call, insert, mark ready. Every failure
// ends as a fixed category on the source; nothing from the source or from library error
// messages reaches the log or the result.

export interface IngestLogEvent {
  event: "ingest";
  outcome: "ready" | "failed" | "skipped";
  category: string | null;
  kind: SourceKind | null;
  sourceId: string;
  bytes: number | null;
  pages: number | null;
  chunks: number | null;
  ms: number;
}

export interface IngestDeps {
  sources: SourceStore;
  objects: ObjectStore;
  extractPdf: (bytes: Uint8Array) => Promise<PdfResult>;
  callModel: (req: ModelCallRequest<"embedding">) => Promise<ModelCallResult<"embedding">>;
  log: (e: IngestLogEvent) => void;
  now: () => number;
}

export type IngestOutcome = { ok: true; chunks: number } | { ok: false; category: string };

class IngestFailure extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

function validVectors(vectors: unknown, count: number): vectors is number[][] {
  return (
    Array.isArray(vectors) &&
    vectors.length === count &&
    vectors.every(
      (v) => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS && v.every((x) => Number.isFinite(x)),
    )
  );
}

export async function ingestSource(deps: IngestDeps, sourceId: string): Promise<IngestOutcome> {
  const startedAt = deps.now();
  const stats = { kind: null as SourceKind | null, bytes: null as number | null, pages: null as number | null, chunks: null as number | null };
  const log = (outcome: IngestLogEvent["outcome"], category: string | null) =>
    deps.log({ event: "ingest", outcome, category, sourceId, ...stats, ms: Math.max(0, Math.round(deps.now() - startedAt)) });

  let claimed;
  try {
    claimed = await deps.sources.claim(sourceId);
  } catch {
    claimed = null;
  }
  if (!claimed) {
    log("skipped", null);
    return { ok: false, category: "not_claimed" };
  }
  stats.kind = claimed.kind;

  try {
    await deps.sources.deleteChunks(sourceId); // a retry starts clean

    let bytes: Uint8Array | null;
    try {
      bytes = await deps.objects.download(claimed.storagePath);
    } catch {
      throw new IngestFailure("storage_failed");
    }
    if (!bytes) throw new IngestFailure("upload_missing");
    stats.bytes = bytes.length;

    if (claimed.kind === "url") throw new IngestFailure("unsupported_type"); // C2
    const check = checkContent(claimed.kind, bytes);
    if (!check.ok) {
      await deps.objects.remove(claimed.storagePath).catch(() => undefined);
      throw new IngestFailure(check.category);
    }

    let pages: PageText[];
    if (claimed.kind === "pdf") {
      const pdf = await deps.extractPdf(bytes);
      if (!pdf.ok) throw new IngestFailure(pdf.category);
      pages = pdf.pages;
    } else {
      pages = [{ page: null, text: normalizeText(new TextDecoder("utf-8").decode(bytes)) }];
    }
    stats.pages = pages.length;

    const chunks = chunkPages(pages);
    stats.chunks = chunks.length;
    if (chunks.length === 0) throw new IngestFailure("no_text");
    if (chunks.length > MAX_CHUNKS_PER_SOURCE) throw new IngestFailure("too_many_chunks");

    const texts = chunks.map((c) => c.content);
    const result = await deps.callModel({ kind: "embedding", notebookId: claimed.notebookId, input: { texts } });
    if (!result.ok) throw new IngestFailure(result.category);
    if (!validVectors(result.output.vectors, texts.length)) throw new IngestFailure("provider_invalid_response");
    const vectors = result.output.vectors;

    const rows: ChunkRow[] = chunks.map((c, i) => ({
      notebook_id: claimed.notebookId,
      source_id: sourceId,
      ordinal: c.ordinal,
      content: c.content,
      page: c.page,
      embedding: vectors[i] as number[],
    }));
    try {
      for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
        await deps.sources.insertChunks(rows.slice(i, i + CHUNK_INSERT_BATCH));
      }
    } catch (error) {
      await deps.sources.deleteChunks(sourceId).catch(() => undefined);
      const code = (error as { code?: unknown }).code;
      throw new IngestFailure(code === "54000" ? "notebook_chunk_limit" : "db_failed");
    }

    await deps.sources.markReady(sourceId);
    log("ready", null);
    return { ok: true, chunks: rows.length };
  } catch (error) {
    const category = error instanceof IngestFailure ? error.category : "db_failed";
    await deps.sources.markFailed(sourceId, category).catch(() => undefined);
    log("failed", category);
    return { ok: false, category };
  }
}
