// Membership changes with the user's own client. Only owners may write memberships;
// RLS from #10 enforces it, and the last-owner guard raises P0001.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignableRole, MemberRole } from "./roles";

export type MemberResult = { ok: true } | { ok: false; code: string };

export interface Member {
  userId: string;
  role: MemberRole;
}

export async function listMembers(client: SupabaseClient, notebookId: string): Promise<Member[]> {
  const { data, error } = await client
    .from("notebook_members")
    .select("user_id, role")
    .eq("notebook_id", notebookId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("listMembers failed");
  return (data ?? []).map((row: { user_id: string; role: MemberRole }) => ({
    userId: row.user_id,
    role: row.role,
  }));
}

function failure(error: { code?: string } | null): MemberResult {
  return { ok: false, code: error?.code ?? "unknown" };
}

export async function addMember(
  client: SupabaseClient,
  notebookId: string,
  userId: string,
  role: AssignableRole,
): Promise<MemberResult> {
  const { error } = await client
    .from("notebook_members")
    .insert({ notebook_id: notebookId, user_id: userId, role });
  return error ? failure(error) : { ok: true };
}

// Update and delete return the affected rows, because RLS filters silently: zero rows
// means the caller may not do this.
export async function changeRole(
  client: SupabaseClient,
  notebookId: string,
  userId: string,
  role: MemberRole,
): Promise<MemberResult> {
  const { data, error } = await client
    .from("notebook_members")
    .update({ role })
    .eq("notebook_id", notebookId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return failure(error);
  return data && data.length > 0 ? { ok: true } : { ok: false, code: "42501" };
}

export async function removeMember(
  client: SupabaseClient,
  notebookId: string,
  userId: string,
): Promise<MemberResult> {
  const { data, error } = await client
    .from("notebook_members")
    .delete()
    .eq("notebook_id", notebookId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return failure(error);
  return data && data.length > 0 ? { ok: true } : { ok: false, code: "42501" };
}
