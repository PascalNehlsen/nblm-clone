"use server";

import { redirect } from "next/navigation";
import { addMember, changeRole, removeMember } from "@/lib/notebooks/members";
import { createNotebook, deleteNotebook } from "@/lib/notebooks/notebooks";
import { isAssignableRole, isUuid, validateTitle } from "@/lib/notebooks/roles";
import { createClient } from "@/lib/supabase/server";

// Every action checks the session with getUser() itself (ADR 0005): an action runs
// before any layout, and the proxy's getClaims() accepts a revoked token. Writes go
// through the user's client, so RLS decides; the UI only hides controls.

async function signedInClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return { supabase, userId: data.user.id };
}

function notebookPath(id: string, fehler?: string): string {
  const base = `/notebooks/${id}`;
  return fehler ? `${base}?fehler=${encodeURIComponent(fehler)}` : base;
}

export async function createNotebookAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const title = validateTitle(formData.get("title"));
  if (!title) redirect("/?fehler=titel");
  let id: string;
  try {
    id = await createNotebook(supabase, title);
  } catch {
    redirect("/?fehler=anlegen");
  }
  redirect(notebookPath(id));
}

export async function addMemberAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const notebookId = formData.get("notebookId");
  const userId = formData.get("userId");
  const role = formData.get("role");
  if (!isUuid(notebookId)) redirect("/");
  if (!isUuid(userId) || !isAssignableRole(role)) redirect(notebookPath(notebookId, "eingabe"));
  const result = await addMember(supabase, notebookId, userId, role);
  redirect(notebookPath(notebookId, result.ok ? undefined : result.code));
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const notebookId = formData.get("notebookId");
  const userId = formData.get("userId");
  const role = formData.get("role");
  if (!isUuid(notebookId)) redirect("/");
  if (!isUuid(userId) || !isAssignableRole(role)) redirect(notebookPath(notebookId, "eingabe"));
  const result = await changeRole(supabase, notebookId, userId, role);
  redirect(notebookPath(notebookId, result.ok ? undefined : result.code));
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const { supabase } = await signedInClient();
  const notebookId = formData.get("notebookId");
  const userId = formData.get("userId");
  if (!isUuid(notebookId)) redirect("/");
  if (!isUuid(userId)) redirect(notebookPath(notebookId, "eingabe"));
  const result = await removeMember(supabase, notebookId, userId);
  redirect(notebookPath(notebookId, result.ok ? undefined : result.code));
}

export async function deleteNotebookAction(formData: FormData): Promise<void> {
  const { supabase, userId } = await signedInClient();
  const notebookId = formData.get("notebookId");
  if (!isUuid(notebookId)) redirect("/");
  // Irreversible: the form requires an explicit confirmation.
  if (formData.get("confirm") !== "on") redirect(notebookPath(notebookId, "bestaetigung"));
  try {
    await deleteNotebook(supabase, notebookId, userId);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    redirect(notebookPath(notebookId, typeof code === "string" ? code : "loeschen"));
  }
  redirect("/?geloescht=1");
}
