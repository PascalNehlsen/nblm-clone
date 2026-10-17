// Small shared helpers for the notebooks/notebook_members RLS matrix (PR 3).
// Every call here goes through a real signed-in client (never the admin/
// service-role credential); see helpers/clients.ts for how those are built.
import { randomUUID } from "node:crypto";
import type { SignedInUser } from "./clients";

export type MemberRole = "owner" | "editor" | "viewer";

/**
 * Creates a notebook as `creator` with a client-generated id and no
 * `.select()` -- the owner membership row is written by an AFTER INSERT
 * trigger, so a RETURNING row would fail the notebooks select policy before
 * that trigger has run (see the PR 3 contract). Throws on error so a failing
 * create surfaces at the call site with the real Postgres/PostgREST error,
 * not a confusing follow-up assertion failure.
 */
export async function createNotebook(creator: SignedInUser, titlePrefix: string): Promise<string> {
  const notebookId = randomUUID();
  const { error } = await creator.client
    .from("notebooks")
    .insert({ id: notebookId, title: `${titlePrefix} ${randomUUID()}` });
  if (error) {
    throw new Error(`createNotebook(${titlePrefix}): ${error.code ?? "?"} ${error.message}`);
  }
  return notebookId;
}

/**
 * Adds `userId` to `notebookId` with `role`, acting as `actor` (normally the
 * notebook's owner, since only an owner may insert a membership). Throws on
 * error, for the same reason as createNotebook.
 */
export async function addMember(
  actor: SignedInUser,
  notebookId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const { error } = await actor.client
    .from("notebook_members")
    .insert({ notebook_id: notebookId, user_id: userId, role });
  if (error) {
    throw new Error(`addMember(${notebookId}, ${userId}, ${role}): ${error.code ?? "?"} ${error.message}`);
  }
}
