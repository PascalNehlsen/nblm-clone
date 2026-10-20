# 0021: Users delete their own account; sole-owned notebooks go first, then the auth user

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

AGENTS.md requires that deleting an account removes sources, chunks (embeddings are personal data), messages and Storage objects, with a test. Until now only notebooks could be deleted, and deleting a sole owner from `auth.users` is blocked by `private.guard_last_owner`. Deleting an auth user needs the admin API, which only the service_role key can call. Storage objects can only be removed while their source rows exist (ADR 0004).

## Decision

- **Where:** a danger zone on `/profil` ("Konto löschen", or "Demo beenden und Daten löschen" for demo users) with a confirmation dialog. The dialog names how many notebooks the user owns alone and how many of them are shared.
- **Order** (`lib/server/account/delete-account.ts`):
  1. Check the session with `getUser()`, then the confirm field.
  2. Check that the admin key is configured. Without it nothing is deleted, which is fail closed on Preview.
  3. Delete every notebook the user owns alone, shared ones included, with the user's own client under RLS: files first (`deleteNotebook`), stopping at the first failure.
  4. List again, with one more pass if a notebook was created meanwhile.
  5. Delete the auth user, then sign out locally.
- **Data the database handles:** foreign keys cascade memberships, messages and citations elsewhere and null `usage.user_id`. The audit table has no foreign keys, so the pg_cron job `nblm-forget-deleted-users` nulls the ids of deleted users every 15 minutes (security invoker, execute revoked).
- **Admin module:** `lib/server/admin/accounts.ts` is the second service_role module next to `admin/usage.ts`. It exports only `adminConfigured()` and `deleteAuthUser(id)`, which accepts only a uuid and returns fixed errors. Only `delete-account.ts` may import it (ESLint plus the boundary tests).
- **User id:** it always comes from the session, never from the form.

## Consequences

- Users can exercise erasure themselves; the Datenschutz page says so.
- The service_role is now reachable from a user-triggered path, but only to delete the caller's own id.
- A stolen session can delete the account: there is no re-authentication. A deletion cannot be undone, and database backups keep the data until their retention ends.
- Audit rows carry a deleted user's id for up to 15 minutes.
- Members of a shared notebook the user owned alone lose it.
- Revisit: offer ownership transfer, or require re-authentication, if notebooks get shared widely.

## Alternatives considered

- **pg_cron deletes marked accounts (no service_role):** slower, and the account keeps working until the job runs.
- **Block deletion while shared notebooks exist:** safer for members, but it leaves the user dependent on others to leave.
- **Synchronous audit nulling through a service_role RPC:** widens service_role further for a 15-minute gap.
