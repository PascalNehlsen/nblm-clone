"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getNotebook } from "@/lib/notebooks/notebooks";
import { isUuid, validateTitle } from "@/lib/notebooks/roles";
import { parseImportUrl } from "@/lib/server/fetch/url";
import { runIngestion } from "@/lib/server/ingest/run";
import { MAX_TEXT_CHARS, MAX_UPLOAD_BYTES } from "@/lib/sources/limits";
import {
  createSignedUpload,
  createSource,
  createUrlSource,
  deleteSource,
  uploadTextObject,
} from "@/lib/sources/sources";
import { createClient } from "@/lib/supabase/server";
import { mergeByPage } from "@/lib/sources/merge";

// Every action checks the session with getUser() itself (ADR 0005). Writes go through
// the user's client, so RLS decides; these checks only refuse early and give a message.
// Viewers and anonymous users are refused here and by the restrictive policies.

export type SourceActionError = "nicht_erlaubt" | "titel" | "groesse" | "typ" | "limit" | "fehler";
export type CreateUploadResult =
  | { ok: true; sourceId: string; signedUrl: string }
  | { ok: false; error: SourceActionError };

async function signedInClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return { supabase, user: data.user };
}

type Client = Awaited<ReturnType<typeof createClient>>;

async function canAddSources(supabase: Client, user: { id: string; is_anonymous?: boolean }, notebookId: string) {
  if (user.is_anonymous === true) return false;
  const notebook = await getNotebook(supabase, notebookId, user.id);
  return notebook?.role === "owner" || notebook?.role === "editor";
}

function notebookPath(id: string, fehler?: string): string {
  const base = `/notebooks/${id}`;
  return fehler ? `${base}?fehler=${encodeURIComponent(fehler)}` : base;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// Step 1 of a PDF upload: the source row, then a signed upload URL for its path. The
// browser uploads the file itself and then calls ingestSourceAction.
export async function createPdfUploadAction(input: {
  notebookId: string;
  title: string;
  size: number;
  type: string;
}): Promise<CreateUploadResult> {
  const { supabase, user } = await signedInClient();
  if (!isUuid(input.notebookId)) return { ok: false, error: "fehler" };
  if (!(await canAddSources(supabase, user, input.notebookId))) return { ok: false, error: "nicht_erlaubt" };
  const title = validateTitle(input.title);
  if (!title) return { ok: false, error: "titel" };
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "groesse" };
  }
  // The client's claim only; the bytes are checked by content during ingestion.
  if (input.type !== "application/pdf") return { ok: false, error: "typ" };

  let source: { id: string; storagePath: string };
  try {
    source = await createSource(supabase, input.notebookId, "pdf", title);
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, error: code === "notebook_source_limit" ? "limit" : code === "nicht_erlaubt" ? "nicht_erlaubt" : "fehler" };
  }
  try {
    const { signedUrl } = await createSignedUpload(supabase, source.storagePath);
    return { ok: true, sourceId: source.id, signedUrl };
  } catch {
    return { ok: false, error: "fehler" };
  }
}

export async function ingestSourceAction(input: {
  notebookId: string;
  sourceId: string;
}): Promise<{ ok: true } | { ok: false; category: string }> {
  const { supabase } = await signedInClient();
  if (!isUuid(input.notebookId) || !isUuid(input.sourceId)) return { ok: false, category: "fehler" };
  const outcome = await runIngestion(supabase, input.sourceId);
  revalidatePath(notebookPath(input.notebookId));
  return outcome.ok ? { ok: true } : { ok: false, category: outcome.category };
}

export async function addTextSourceAction(formData: FormData): Promise<void> {
  const { supabase, user } = await signedInClient();
  const notebookId = formData.get("notebookId");
  if (!isUuid(notebookId)) redirect("/");
  if (!(await canAddSources(supabase, user, notebookId))) redirect(notebookPath(notebookId, "nicht_erlaubt"));
  const title = validateTitle(formData.get("title"));
  if (!title) redirect(notebookPath(notebookId, "titel"));
  const raw = formData.get("text");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0 || text.length > MAX_TEXT_CHARS) redirect(notebookPath(notebookId, "text"));

  let source: { id: string; storagePath: string };
  try {
    source = await createSource(supabase, notebookId, "text", title);
    await uploadTextObject(supabase, source.storagePath, text);
  } catch (error) {
    redirect(notebookPath(notebookId, errorCode(error) === "notebook_source_limit" ? "limit" : "fehler"));
  }
  // Ingestion failures show on the source in the list, not as a page error.
  await runIngestion(supabase, source.id);
  redirect(notebookPath(notebookId));
}

// A web page as source (C2). The URL rules run here before any insert, so a refused URL
// leaves no row; the fetch itself runs through the SSRF guard during ingestion.
function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

export async function addUrlSourceAction(formData: FormData): Promise<void> {
  const { supabase, user } = await signedInClient();
  const notebookId = formData.get("notebookId");
  if (!isUuid(notebookId)) redirect("/");
  if (!(await canAddSources(supabase, user, notebookId))) redirect(notebookPath(notebookId, "nicht_erlaubt"));
  const title = validateTitle(formData.get("title"));
  if (!title) redirect(notebookPath(notebookId, "titel"));
  const raw = formData.get("url");
  const parsed = parseImportUrl(typeof raw === "string" ? raw.trim() : "");
  if (!parsed.ok) redirect(notebookPath(notebookId, "url"));
  // A YouTube page has almost no text in its HTML (video and captions load by script), so it
  // would only produce an empty or broken source. Refused before any fetch.
  if (isYouTubeHost(parsed.url.hostname)) redirect(notebookPath(notebookId, "youtube"));

  let source: { id: string; storagePath: string };
  try {
    source = await createUrlSource(supabase, notebookId, title, parsed.url.href);
  } catch (error) {
    redirect(notebookPath(notebookId, errorCode(error) === "notebook_source_limit" ? "limit" : "fehler"));
  }
  await runIngestion(supabase, source.id);
  redirect(notebookPath(notebookId));
}

export async function deleteSourceAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const notebookId = formData.get("notebookId");
  const sourceId = formData.get("sourceId");
  if (!isUuid(notebookId)) redirect("/");
  if (!isUuid(sourceId)) redirect(notebookPath(notebookId, "eingabe"));
  // Irreversible: the form requires an explicit confirmation (the dialog in source-list.tsx).
  if (formData.get("confirm") !== "on") redirect(notebookPath(notebookId, "bestaetigung_quelle"));
  try {
    await deleteSource(supabase, sourceId);
  } catch (error) {
    redirect(notebookPath(notebookId, errorCode(error) ?? "loeschen"));
  }
  redirect(notebookPath(notebookId));
}

export async function retrySourceAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const notebookId = formData.get("notebookId");
  const sourceId = formData.get("sourceId");
  if (!isUuid(notebookId)) redirect("/");
  if (!isUuid(sourceId)) redirect(notebookPath(notebookId, "eingabe"));
  await runIngestion(supabase, sourceId);
  redirect(notebookPath(notebookId));
}

// Reading a whole source (the margin's source view). The user's own client, so RLS decides;
// both ids must match, so a source of another notebook is never returned.
const READ_CHUNK_LIMIT = 400;

export async function readSourceAction(input: {
  notebookId: unknown;
  sourceId: unknown;
}): Promise<
  | {
      ok: true;
      title: string;
      kind: "text" | "pdf" | "url";
      url: string | null;
      sections: { page: number | null; text: string }[];
      truncated: boolean;
    }
  | { ok: false }
> {
  const { notebookId, sourceId } = input;
  if (!isUuid(notebookId) || !isUuid(sourceId)) return { ok: false };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false };
  const { data: source } = await supabase
    .from("sources")
    .select("title, kind, source_url")
    .eq("notebook_id", notebookId)
    .eq("id", sourceId)
    .maybeSingle();
  if (!source) return { ok: false };
  const { data: chunks, error } = await supabase
    .from("chunks")
    .select("content, page, ordinal")
    .eq("notebook_id", notebookId)
    .eq("source_id", sourceId)
    .order("ordinal", { ascending: true })
    .limit(READ_CHUNK_LIMIT + 1);
  if (error || !chunks) return { ok: false };
  const truncated = chunks.length > READ_CHUNK_LIMIT;
  // Chunks overlap; merged per page so the reader shows each passage once.
  const sections = mergeByPage(
    chunks.slice(0, READ_CHUNK_LIMIT).map((c) => ({
      page: typeof c.page === "number" ? c.page : null,
      content: String(c.content),
    })),
  );
  const kind = source.kind === "pdf" || source.kind === "url" ? source.kind : "text";
  const url = kind === "url" && typeof source.source_url === "string" ? source.source_url : null;
  return { ok: true, title: String(source.title), kind, url, sections, truncated };
}
