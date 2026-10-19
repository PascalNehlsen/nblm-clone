# 0012: Demo users get a database-side copy of one template and are purged after 24 hours

- Status: accepted
- Date: 2026-10-19

## Context

The roadmap asks for a one-click demo: anonymous sign-in behind Turnstile, a personal copy of a demo notebook, deleted after 24 hours. An anonymous user can neither read the template nor insert sources or chunks (restrictive policies since A1), and copying through the app would need `service_role` or a model call per copy. privacy.md also promised two 90-day retention jobs with this block.

## Decision

- **Template**: one ordinary notebook, owned by a GitHub account, registered in `private.demo_template` (one row, no API access, changed only by SQL, runbook `demo-template.md`), with `max_live_copies` (default 100).
- **Copy**: `private.copy_demo_template()`, an AFTER INSERT trigger on `public.notebooks` that runs only for callers with the `is_anonymous` claim. It copies the template's `ready` sources and their chunks with embeddings (no model call, no Storage objects) into the new notebook, and refuses with `demo_notebook_exists` (one notebook per anonymous user), `demo_unavailable` (no template) or `demo_capacity` (cap reached). It is SECURITY DEFINER because the caller cannot read the template; it is added to the definer allowlist as a trigger function under the rules of ADR 0001 (in `private`, returns trigger, `search_path = ''`, execute revoked).
- **Purge**: `private.purge_expired_demo_users()` (invoker, run by pg_cron as `postgres` every 15 minutes, 200 users per run) deletes anonymous users older than 24 hours: first the notebooks only they own (cascade), then the users, then their ids in the membership audit.
- **Retention**: daily pg_cron jobs delete membership audit rows older than 90 days and remove user, notebook and message ids from usage rows older than 90 days.
- **Captcha** (F2): Turnstile through Supabase Auth's built-in captcha, so the check cannot be skipped by calling Supabase directly.

## Consequences

- No per-copy cost; a copy is about 0.3 MB at 50 chunks, bounded by the cap.
- "Deleted after 24 h" means within 24 h 15 min.
- The definer trigger crosses a notebook boundary, bounded to one template, anonymous callers, one copy each and the cap; pgTAP and the RLS matrix pin this.
- Every new anonymous user starts with a fresh anonymous budget; Turnstile, the per-IP limit, the cap, the global budget and the kill switch bound it (SECURITY.md, F2).
- Local seed data now contains a template (tests need it; only `postgres` can register one).

## Alternatives considered

- **Copy through a `service_role` RPC from `lib/server/admin/`**: widens `service_role` use and its import boundary.
- **Read-only viewer access to one shared template**: no copies, but not the roadmap's personal notebook.
- **Own Turnstile siteverify in Next.js**: bypassable, because anonymous sign-in is a public Supabase endpoint.
