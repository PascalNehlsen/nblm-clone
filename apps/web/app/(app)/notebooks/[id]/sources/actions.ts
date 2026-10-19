"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getNotebook } from "@/lib/notebooks/notebooks";
import { isUuid, validateTitle } from "@/lib/notebooks/roles";
import { runIngestion } from "@/lib/server/ingest/run";
import { MAX_TEXT_CHARS, MAX_UPLOAD_BYTES } from "@/lib/sources/limits";
import { createSignedUpload, createSource, deleteSource, uploadTextObject } from "@/lib/sources/sources";
import { createClient } from "@/lib/supabase/server";

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

export async function deleteSourceAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const notebookId = formData.get("notebookId");
  const sourceId = formData.get("sourceId");
  if (!isUuid(notebookId)) redirect("/");
  if (!isUuid(sourceId)) redirect(notebookPath(notebookId, "eingabe"));
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
