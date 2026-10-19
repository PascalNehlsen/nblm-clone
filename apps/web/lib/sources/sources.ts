// Source queries with the user's own client: RLS decides what each call may see or
// change, as in lib/notebooks. No admin client and no secrets, so this module is not
// limited to the server: the RLS tests import these functions directly.
import type { SupabaseClient } from "@supabase/supabase-js";
import { STALE_PROCESSING_MS } from "./limits";

export type SourceKind = "pdf" | "text" | "url";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export interface SourceSummary {
  id: string;
  title: string;
  kind: SourceKind;
  status: SourceStatus;
  errorCategory: string | null;
  createdAt: string;
  statusChangedAt: string;
}

export interface ClaimedSource {
  id: string;
  notebookId: string;
  kind: SourceKind;
  storagePath: string;
}

export interface ChunkRow {
  notebook_id: string;
  source_id: string;
  ordinal: number;
  content: string;
  page: number | null;
  embedding: number[];
}

export interface SourceStore {
  claim(sourceId: string): Promise<ClaimedSource | null>;
  markReady(sourceId: string): Promise<void>;
  markFailed(sourceId: string, category: string): Promise<void>;
  deleteChunks(sourceId: string): Promise<void>;
  insertChunks(rows: ChunkRow[]): Promise<void>;
}

export interface ObjectStore {
  download(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
}

const BUCKET = "sources";

function failure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

interface SourceRow {
  id: string;
  title: string;
  kind: SourceKind;
  status: SourceStatus;
  error_category: string | null;
  created_at: string;
  status_changed_at: string;
}

export async function listSources(client: SupabaseClient, notebookId: string): Promise<SourceSummary[]> {
  const { data, error } = await client
    .from("sources")
    .select("id, title, kind, status, error_category, created_at, status_changed_at")
    .eq("notebook_id", notebookId)
    .order("created_at", { ascending: false })
    .returns<SourceRow[]>();
  if (error) throw new Error("listSources failed");
  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    errorCategory: row.error_category,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
  }));
}

// The id and storage_path come from the database; only these three columns are granted.
export async function createSource(
  client: SupabaseClient,
  notebookId: string,
  kind: "pdf" | "text",
  title: string,
): Promise<{ id: string; storagePath: string }> {
  const { data, error } = await client
    .from("sources")
    .insert({ notebook_id: notebookId, kind, title })
    .select("id, storage_path")
    .single<{ id: string; storage_path: string }>();
  if (error || !data) {
    if (error?.code === "54000" && error.message.includes("notebook_source_limit")) {
      throw failure("createSource: source limit", "notebook_source_limit");
    }
    if (error?.code === "42501") throw failure("createSource: not allowed", "nicht_erlaubt");
    throw failure("createSource failed", "fehler");
  }
  return { id: data.id, storagePath: data.storage_path };
}

// The browser uploads straight to Storage with this URL (Vercel caps request bodies at
// 4.5 MB). Storage checks the object insert policy, so only owners and editors of the
// source's notebook get one, for a path that belongs to an existing source row.
export async function createSignedUpload(client: SupabaseClient, storagePath: string): Promise<{ signedUrl: string }> {
  const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error || !data) throw new Error("createSignedUpload failed");
  return { signedUrl: data.signedUrl };
}

export async function uploadTextObject(client: SupabaseClient, storagePath: string, text: string): Promise<void> {
  const { error } = await client.storage
    .from(BUCKET)
    .upload(storagePath, new Blob([text], { type: "text/plain" }), { contentType: "text/plain", upsert: false });
  if (error) throw new Error("uploadTextObject failed");
}

// ADR 0004 order: the object first, then the row. Afterwards the Storage policies find no
// source row, so the object could no longer be removed with the user's login. Chunks and
// their embeddings go with the foreign key cascade.
export async function deleteSource(client: SupabaseClient, sourceId: string): Promise<void> {
  const { data: row } = await client
    .from("sources")
    .select("id, notebook_id, storage_path")
    .eq("id", sourceId)
    .maybeSingle<{ id: string; notebook_id: string; storage_path: string }>();
  if (!row) throw failure("deleteSource: not allowed", "nicht_erlaubt");

  const { error: removeError } = await client.storage.from(BUCKET).remove([row.storage_path]);
  if (removeError) throw failure("deleteSource: removing the file failed", "loeschen");
  const { data: left, error: listError } = await client.storage
    .from(BUCKET)
    .list(row.notebook_id, { search: row.id });
  if (listError) throw failure("deleteSource: checking the file failed", "loeschen");
  if ((left ?? []).some((object: { name: string }) => object.name === row.id)) {
    throw failure("deleteSource: the file is left", "dateien_uebrig");
  }

  const { count, error } = await client.from("sources").delete({ count: "exact" }).eq("id", sourceId);
  if (error || count !== 1) throw failure("deleteSource: not allowed", "nicht_erlaubt");
}

export function sourceStore(client: SupabaseClient): SourceStore {
  async function update(sourceId: string, payload: Record<string, unknown>): Promise<void> {
    const { error } = await client.from("sources").update(payload).eq("id", sourceId);
    if (error) throw failure("updating the source failed", error.code ?? "fehler");
  }

  return {
    // Takes a source that is pending, failed, or stuck in processing past the stale
    // cutoff (a killed function), so a retry works and two runs never overlap. Zero rows
    // means not allowed under RLS, already ready, or running right now.
    async claim(sourceId) {
      const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
      const { data, error } = await client
        .from("sources")
        .update({ status: "processing", error_category: null })
        .eq("id", sourceId)
        .or(`status.in.(pending,failed),and(status.eq.processing,status_changed_at.lt."${cutoff}")`)
        .select("id, notebook_id, kind, storage_path");
      if (error) throw failure("claiming the source failed", error.code ?? "fehler");
      const row = (data as { id: string; notebook_id: string; kind: SourceKind; storage_path: string }[] | null)?.[0];
      return row ? { id: row.id, notebookId: row.notebook_id, kind: row.kind, storagePath: row.storage_path } : null;
    },
    markReady: (sourceId) => update(sourceId, { status: "ready", error_category: null }),
    markFailed: (sourceId, category) => update(sourceId, { status: "failed", error_category: category }),
    async deleteChunks(sourceId) {
      const { error } = await client.from("chunks").delete().eq("source_id", sourceId);
      if (error) throw failure("deleting chunks failed", error.code ?? "fehler");
    },
    async insertChunks(rows) {
      const { error } = await client.from("chunks").insert(rows);
      if (error) throw failure("inserting chunks failed", error.code ?? "fehler");
    },
  };
}

function isMissingObject(error: { message?: string; statusCode?: string; status?: number }): boolean {
  return (
    error.statusCode === "404" ||
    error.status === 404 ||
    error.status === 400 ||
    /not.?found/i.test(error.message ?? "")
  );
}

export function objectStore(client: SupabaseClient): ObjectStore {
  return {
    async download(path) {
      const { data, error } = await client.storage.from(BUCKET).download(path);
      if (error) {
        if (isMissingObject(error as { message?: string; statusCode?: string; status?: number })) return null;
        throw new Error("downloading the file failed");
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(path) {
      const { error } = await client.storage.from(BUCKET).remove([path]);
      if (error) throw new Error("removing the file failed");
    },
  };
}
