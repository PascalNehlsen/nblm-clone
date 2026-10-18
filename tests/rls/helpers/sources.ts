// Shared helpers for the sources/chunks/messages/match_chunks RLS matrix (PR
// A1). Every call here goes through a real signed-in client (never the admin/
// service-role credential); see helpers/clients.ts for how those are built.
import { randomUUID } from "node:crypto";
import type { SignedInUser } from "./clients";

export type SourceKind = "pdf" | "text" | "url";
export type MessageRole = "user" | "assistant";

export const EMBEDDING_DIMENSIONS = 1024;

/**
 * `sources.storage_path` is a stored generated column -- exactly
 * `notebook_id::text || '/' || id::text` -- and `id` itself comes only from
 * its `gen_random_uuid()` default; neither is in the INSERT column grant
 * (only notebook_id, kind, title are), so no client ever sends either one.
 * `unique (storage_path)` still applies, now enforced on a value Postgres
 * computes itself. Fixed a second Codex finding on top of the first (a
 * client-chosen filename let two sources share one Storage object, so
 * deleting one silently deleted the other's file): even a client-chosen
 * *id* let an editor delete a source and then recreate one with the same id,
 * rebinding whatever Storage object happened to be left at that path. This
 * helper is still exported for tests that independently need to compute the
 * expected value from an id the server already returned.
 */
export function storagePath(notebookId: string, id: string): string {
  return `${notebookId}/${id}`;
}

/** The "query" vector every recall/clamp test searches for: a unit vector
 * along the first dimension, nothing in the rest. */
export function queryVector(): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  return vector;
}

/**
 * A vector nudged away from queryVector() by `noise` in a `seed`-dependent
 * direction, so every (seed, noise) pair is reproducible and distinct. Cosine
 * distance to queryVector() grows with `noise` alone (not with `seed`), so
 * the recall test below uses a small `noise` for the "foreign, deceptively
 * close" chunks and a larger `noise` for the caller's own, genuinely relevant
 * chunks. match_chunks does an exact search (no approximate index -- see
 * supabase/tests/database/020_sources_chunks_messages.test.sql), so the point
 * of that setup is no longer about defeating an approximate scan: it is that
 * `where notebook_id = p_notebook_id` has to actually restrict the candidate
 * set before the distance ordering and LIMIT, not merely filter a global
 * top-K after the fact, which could lose every one of the caller's own
 * chunks to a foreign notebook with enough closer ones.
 */
export function nearbyVector(seed: number, noise: number): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  for (let i = 1; i < EMBEDDING_DIMENSIONS; i += 1) {
    vector[i] = noise * Math.sin(seed * (i + 1));
  }
  return vector;
}

export interface CreateSourceOptions {
  kind?: SourceKind;
  title?: string;
}

/**
 * Creates a source as `actor`. The insert column grant is notebook_id, kind,
 * title only -- `id` (default `gen_random_uuid()`) and `storage_path`
 * (generated always as `notebook_id::text || '/' || id::text`, stored) are
 * never sent, only read back via `.select()`. The `RETURNING` read-back is
 * safe under RLS here because the inserting actor is already a member by the
 * time the select policy runs (unlike notebooks' bootstrap-trigger case,
 * sources' membership comes from an existing notebook_members row, not a
 * trigger that fires after this same statement). `title` keeps the original
 * upload's file name. Throws on error so a failing create surfaces at the
 * call site with the real Postgres/PostgREST error.
 */
export async function createSource(
  actor: SignedInUser,
  notebookId: string,
  options: CreateSourceOptions = {},
): Promise<string> {
  const kind = options.kind ?? "text";
  const title = options.title ?? `source-${randomUUID()}.txt`;

  const { data, error } = await actor.client
    .from("sources")
    .insert({ notebook_id: notebookId, kind, title })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`createSource(${notebookId}): ${error?.code ?? "?"} ${error?.message}`);
  }
  return data.id as string;
}

export interface ChunkInput {
  ordinal: number;
  content: string;
  embedding: number[];
  page?: number | null;
}

/** Bulk-inserts every chunk in one request (PostgREST accepts an array body),
 * which matters for the recall/clamp fixtures that need dozens to hundreds of
 * rows. Throws on error, for the same reason as createSource. */
export async function insertChunks(
  actor: SignedInUser,
  notebookId: string,
  sourceId: string,
  chunks: ChunkInput[],
): Promise<void> {
  const rows = chunks.map((chunk) => ({
    notebook_id: notebookId,
    source_id: sourceId,
    ordinal: chunk.ordinal,
    content: chunk.content,
    embedding: chunk.embedding,
    page: chunk.page ?? null,
  }));

  const { error } = await actor.client.from("chunks").insert(rows);
  if (error) {
    throw new Error(`insertChunks(${notebookId}, ${sourceId}): ${error.code ?? "?"} ${error.message}`);
  }
}

/**
 * Inserts `count` chunks against a fresh source in one request, every one
 * `noise` away from queryVector() with a distinct seed. Returns the created
 * source id and the ids PostgREST assigned, read back via `.select()` since
 * chunks are not client-id'd like sources/notebooks are.
 */
export async function createSourceWithChunks(
  actor: SignedInUser,
  notebookId: string,
  count: number,
  noise: number,
  seedOffset = 0,
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const sourceId = await createSource(actor, notebookId);
  const rows = Array.from({ length: count }, (_, i) => ({
    notebook_id: notebookId,
    source_id: sourceId,
    ordinal: i,
    content: `chunk ${i}`,
    embedding: nearbyVector(seedOffset + i + 1, noise),
    page: null,
  }));

  const { data, error } = await actor.client.from("chunks").insert(rows).select("id");
  if (error) {
    throw new Error(`createSourceWithChunks(${notebookId}): ${error.code ?? "?"} ${error.message}`);
  }
  return { sourceId, chunkIds: (data ?? []).map((row) => row.id as string) };
}

/** Inserts a message as `actor` with a client-generated id (the insert
 * column grant is id, notebook_id, role, content -- `user_id` defaults to
 * auth.uid() and is not grantable). Citations live in their own table,
 * public.message_citations (see insertCitation below), not on this row. */
export async function insertMessage(
  actor: SignedInUser,
  notebookId: string,
  role: MessageRole,
  content: string,
): Promise<string> {
  const id = randomUUID();
  const { error } = await actor.client.from("messages").insert({ id, notebook_id: notebookId, role, content });
  if (error) {
    throw new Error(`insertMessage(${notebookId}): ${error.code ?? "?"} ${error.message}`);
  }
  return id;
}

export interface InsertCitationOptions {
  chunkId?: string | null;
  quote?: string | null;
}

/**
 * Inserts a citation row as `actor` for `messageId` (which must belong to
 * `notebookId` and, per the RLS policy, to `actor` themselves). The insert
 * policy additionally requires chunk_id is not null, so the default here
 * matches the common case; pass `{ chunkId: null }` explicitly only for
 * tests of that specific rejection.
 */
export async function insertCitation(
  actor: SignedInUser,
  notebookId: string,
  messageId: string,
  ordinal: number,
  options: InsertCitationOptions,
): Promise<void> {
  const { error } = await actor.client.from("message_citations").insert({
    message_id: messageId,
    notebook_id: notebookId,
    ordinal,
    chunk_id: options.chunkId ?? null,
    quote: options.quote ?? null,
  });
  if (error) {
    throw new Error(`insertCitation(${messageId}, ${ordinal}): ${error.code ?? "?"} ${error.message}`);
  }
}
