import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { adminConfigured, deleteAuthUser } from "../admin/accounts";
import { deleteNotebook } from "../../notebooks/notebooks";

// Account deletion (ADR 0021). Everything the user owns alone goes first, with the user's own
// client under RLS (deleteNotebook removes the Storage objects before the row, ADR 0004);
// then the auth user is deleted, which cascades memberships, messages and citations
// elsewhere and nulls the user's id in usage rows. The id comes only from getUser() of the
// session, never from the form. Relative imports only: the RLS tests import this module.

export interface DeleteAccountDeps {
  client: SupabaseClient;
  adminConfigured: () => boolean;
  deleteAuthUser: (userId: string) => Promise<void>;
  signOut: (options: { scope: "local" }) => Promise<unknown>;
}

export const DONE = "/login?konto=geloescht";
const SIGNED_OUT = "/login";
const NOT_CONFIRMED = "/profil?fehler=bestaetigung";
const FAILED = "/profil?fehler=konto_loeschen";

const PAGE = 1000;

interface MemberRow {
  notebook_id: string;
  user_id: string;
  role: string;
}

async function memberships(client: SupabaseClient, filter: { userId?: string; notebookIds?: string[] }): Promise<MemberRow[]> {
  const rows: MemberRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = client.from("notebook_members").select("notebook_id, user_id, role");
    if (filter.userId) q = q.eq("user_id", filter.userId);
    if (filter.notebookIds) q = q.in("notebook_id", filter.notebookIds);
    const { data, error } = await q.order("notebook_id").range(from, from + PAGE - 1);
    if (error) throw new Error("deleteAccount: membership lookup failed");
    const page = (data ?? []) as MemberRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// The notebooks where the user is an owner and no one else is.
export async function soleOwnedNotebooks(client: SupabaseClient, userId: string): Promise<string[]> {
  const owned = (await memberships(client, { userId })).filter((m) => m.role === "owner").map((m) => m.notebook_id);
  if (owned.length === 0) return [];
  const coOwned = new Set<string>();
  for (let i = 0; i < owned.length; i += 100) {
    const batch = owned.slice(i, i + 100);
    for (const m of await memberships(client, { notebookIds: batch })) {
      if (m.role === "owner" && m.user_id !== userId) coOwned.add(m.notebook_id);
    }
  }
  return owned.filter((id) => !coOwned.has(id));
}

// What the deletion dialog names: notebooks the user owns alone, and how many of them have
// other members (who lose access). null on any lookup error, never a partial count: the
// dialog then warns in general terms instead of understating what goes.
export async function deletionSummary(client: SupabaseClient, userId: string): Promise<{ sole: number; shared: number } | null> {
  try {
    const sole = await soleOwnedNotebooks(client, userId);
    const shared = new Set<string>();
    for (let i = 0; i < sole.length; i += 100) {
      for (const m of await memberships(client, { notebookIds: sole.slice(i, i + 100) })) {
        if (m.user_id !== userId) shared.add(m.notebook_id);
      }
    }
    return { sole: sole.length, shared: shared.size };
  } catch {
    return null;
  }
}

export async function deleteAccount(deps: DeleteAccountDeps, form: FormData): Promise<{ redirectTo: string }> {
  const { data } = await deps.client.auth.getUser();
  const user = data.user;
  if (!user) return { redirectTo: SIGNED_OUT };
  if (form.get("confirm") !== "on") return { redirectTo: NOT_CONFIRMED };
  if (!deps.adminConfigured()) return { redirectTo: FAILED };

  try {
    // A second pass catches a notebook created in another tab meanwhile.
    for (let pass = 0; pass < 2; pass++) {
      const sole = await soleOwnedNotebooks(deps.client, user.id);
      if (sole.length === 0) break;
      for (const id of sole) await deleteNotebook(deps.client, id, user.id);
    }
    if ((await soleOwnedNotebooks(deps.client, user.id)).length > 0) return { redirectTo: FAILED };
    await deps.deleteAuthUser(user.id);
  } catch {
    return { redirectTo: FAILED };
  }

  try {
    await deps.signOut({ scope: "local" });
  } catch {
    // The user is gone; a stale cookie only fails its next request.
  }
  return { redirectTo: DONE };
}

// The real admin call, bound here because only this module may import admin/accounts.
export function deleteAccountDeps(client: SupabaseClient): DeleteAccountDeps {
  return {
    client,
    adminConfigured,
    deleteAuthUser,
    signOut: (options) => client.auth.signOut(options),
  };
}
