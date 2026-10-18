// Notebook queries with the user's own client: RLS decides what each call may see or
// change. No admin client here, and no secrets, so no "server-only": the RLS tests
// import these functions directly. Callers that already checked the session pass the
// user id to save an Auth round trip.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemberRole } from "./roles";

export interface NotebookSummary {
  id: string;
  title: string;
  role: MemberRole;
}

interface MembershipRow {
  role: MemberRole;
  notebooks: { id: string; title: string } | null;
}

const PAGE = 1000; // PostgREST max_rows and the Storage bulk remove limit

async function currentUserId(client: SupabaseClient, known?: string): Promise<string> {
  if (known) return known;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("not signed in");
  return data.user.id;
}

export async function listNotebooks(
  client: SupabaseClient,
  knownUserId?: string,
): Promise<NotebookSummary[]> {
  const userId = await currentUserId(client, knownUserId);
  const { data, error } = await client
    .from("notebook_members")
    .select("role, notebooks(id, title)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .returns<MembershipRow[]>();
  if (error) throw new Error("listNotebooks failed");
  return (data ?? []).flatMap((row) =>
    row.notebooks ? [{ id: row.notebooks.id, title: row.notebooks.title, role: row.role }] : [],
  );
}

// No .select(): RLS checks RETURNING before the owner membership exists (see the #10
// migration), so the id is generated here and returned.
export async function createNotebook(client: SupabaseClient, title: string): Promise<string> {
  const id = crypto.randomUUID();
  const { error } = await client.from("notebooks").insert({ id, title });
  if (error) throw Object.assign(new Error("createNotebook failed"), { code: error.code });
  return id;
}

export async function getNotebook(
  client: SupabaseClient,
  id: string,
  knownUserId?: string,
): Promise<NotebookSummary | null> {
  const userId = await currentUserId(client, knownUserId);
  const { data, error } = await client
    .from("notebook_members")
    .select("role, notebooks(id, title)")
    .eq("notebook_id", id)
    .eq("user_id", userId)
    .returns<MembershipRow[]>()
    .maybeSingle();
  if (error || !data?.notebooks) return null;
  return { id: data.notebooks.id, title: data.notebooks.title, role: data.role };
}

// ADR 0004: Storage objects first, then the row. Afterwards the Storage policies find
// no source row, so the objects could no longer be removed with the user's login.
// The owner check comes first: Storage lets editors delete files too, but only owners
// may delete the notebook, so an editor must not get as far as the files.
export async function deleteNotebook(
  client: SupabaseClient,
  id: string,
  knownUserId?: string,
): Promise<{ removedPaths: string[] }> {
  const userId = await currentUserId(client, knownUserId);
  const { data: membership, error: roleError } = await client
    .from("notebook_members")
    .select("role")
    .eq("notebook_id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (roleError) throw new Error("deleteNotebook: role lookup failed");
  if (membership?.role !== "owner") {
    throw Object.assign(new Error("deleteNotebook: not allowed"), { code: "42501" });
  }

  // All source paths, page by page (a single select stops at max_rows).
  const paths: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: listError } = await client
      .from("sources")
      .select("storage_path")
      .eq("notebook_id", id)
      .order("id")
      .range(from, from + PAGE - 1);
    if (listError) throw new Error("deleteNotebook: listing sources failed");
    paths.push(...(page ?? []).map((s: { storage_path: string }) => s.storage_path));
    if (!page || page.length < PAGE) break;
  }

  // Remove in batches. Storage reports only what it really removed, so a source whose
  // upload never happened shows up as "missing" too. What counts is what is left:
  // the source rows still exist, so the select policy shows every remaining object.
  const removedPaths: string[] = [];
  for (let i = 0; i < paths.length; i += PAGE) {
    const batch = paths.slice(i, i + PAGE);
    const { data: removed, error: removeError } = await client.storage.from("sources").remove(batch);
    if (removeError) throw new Error("deleteNotebook: removing files failed");
    removedPaths.push(...(removed ?? []).map((object: { name: string }) => object.name));
  }
  for (let offset = 0; ; offset += PAGE) {
    const { data: left, error: listError } = await client.storage
      .from("sources")
      .list(id, { limit: PAGE, offset });
    if (listError) throw new Error("deleteNotebook: checking remaining files failed");
    // Keep the row while any file is left, so none is orphaned silently.
    if (left && left.length > 0) throw new Error("deleteNotebook: files are left");
    if (!left || left.length < PAGE) break;
  }

  const { count, error: deleteError } = await client
    .from("notebooks")
    .delete({ count: "exact" })
    .eq("id", id);
  if (deleteError) throw Object.assign(new Error("deleteNotebook failed"), { code: deleteError.code });
  // RLS filters silently: nothing deleted means the caller may not delete it.
  if (count !== 1) throw Object.assign(new Error("deleteNotebook: not allowed"), { code: "42501" });
  return { removedPaths };
}
