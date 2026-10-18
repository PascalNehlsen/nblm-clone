# 0001: Membership checks use one SECURITY DEFINER helper; definer triggers are named exceptions

- Status: accepted
- Date: 2026-10-17

## Context

Every policy on notebooks and their child tables asks "what is this user's role in this notebook?". The answer lives in `notebook_members`, which has RLS itself, so a policy that queries it directly recurses. Two writes also need rights the caller does not have yet: creating a notebook must make the creator its owner before any membership exists, and every membership change must land in an audit table no API role can touch. A `security definer` function runs with its owner's rights and bypasses RLS, so each one is a hole if it is callable or can be tricked through `search_path`.

## Decision

- `private.notebook_role(uuid)` is the only general `security definer` function: `stable`, `language sql`, read-only, `set search_path = ''`, in the schema `private` that the API does not expose. Execute is revoked from `public` and `anon` and granted to `authenticated`. Policies call it; only it and the trigger functions below read `notebook_members` for access decisions.
- Besides it, only trigger functions may be `security definer`: in `private`, `returns trigger`, `set search_path = ''`, execute revoked from `public`, `anon` and `authenticated`, each named in the allowlist of `supabase/tests/database/000_catalog.test.sql`. Today: `private.add_notebook_owner()` (owner bootstrap), `private.audit_membership()` (audit), `private.guard_last_owner()` (at least one owner per notebook) and `private.redact_cited_answers()` (replaces the text of answers that cited a deleted source, ADR 0004). A trigger function cannot be called directly, and it only sees `new` and `old`; `redact_cited_answers` additionally writes one column, the content of the assistant message referenced by the updated citation row.
- The catalog check enforces all of this with self-tests: allowlist by OID, location, exact `search_path=""`, return type, no execute for PUBLIC, anon or authenticated. A new definer function fails CI until it is added to the allowlist in a reviewed PR.

## Consequences

Policies stay simple and do not recurse. Every extra definer function is visible in one list and needs a change to a guardrail test. The last-owner guard is a definer trigger because as invoker its lock went through RLS: in a bulk delete or demote by `notebook_id`, the acting owner stopped being an owner mid-statement, the notebook looked deleted and the guard let the last owner go (found in review, reproduced, covered by tests). Owners are flat: any owner can demote or remove another owner, including the creator, and delete the notebook. Upserts with merge on either table fail with 42501, because key columns have no update grant; clients use plain inserts. Cost: inserting a notebook cannot use `RETURNING`, because the owner membership only exists after the AFTER trigger; clients send their own `id`. Revisit if a definer function is needed that is not a trigger, or if Postgres or Supabase offers membership checks without bypassing RLS.

## Alternatives considered

- **Policies that query `notebook_members` directly**: recursion, and slow per-row subqueries.
- **A `security definer` RPC `create_notebook()`**: callable by any signed-in user with arbitrary arguments; a bigger surface than a trigger.
- **Owner access through `created_by`**: a creator who is demoted or removed would keep access.
- **Audit table writable by `authenticated`**: users could write or erase their own audit trail.
