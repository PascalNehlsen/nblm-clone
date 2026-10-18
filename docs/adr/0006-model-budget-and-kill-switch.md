# 0006: Only the server writes model usage, through service_role RPCs

- Status: accepted
- Date: 2026-10-18

## Context

Every model call (embeddings in PR C, chat in PR D) must pass a per-user daily budget check first, tighter for anonymous users, and a global kill switch must stop all model features without a deploy (AGENTS.md). Anything the server can do with the user's JWT, the user can also do directly through PostgREST with the public key. Reserving budget with the user's login would be harmless, but settling would not: a user could settle their own reservations at cost 0 and spend without limit. So the actual cost has to be written with a credential users never hold.

## Decision

- `private.usage` holds one row per logical model operation (one source's embeddings, one chat turn) with `call_count`, model id, tokens, cost in USD, latency and status. It holds no prompt, source or answer text, and the API cannot reach it.
- `private.model_settings` is a single row: the kill switch (`model_features_enabled`), 0.50 USD per user per day, 0.20 USD per anonymous user per day, 5 USD per day across all users. It is seeded with model features off; a human enables each environment through [the runbook](../runbooks/kill-switch.md).
- `public.reserve_model_call` and `public.settle_model_call` are `security invoker` with `search_path = ''`, and only `service_role` may execute them. The secret key lives in one server module under `lib/server/admin/` (PR E2). ADR 0001 is unchanged: no new `security definer` function.
- Reserve before the call, settle after. One transaction-scoped advisory lock serializes reservations, so concurrent calls cannot pass the per-user or the global check together; the function refuses to run outside read committed, where the lock would not protect the sums. The reservation counts the upper-bound estimate; settle replaces it with the actual cost. Reserved and failed rows count, so a crashed call keeps its reservation until the day ends.
- Even `service_role` cannot go around the functions: it inserts only the columns a reservation sets (no status, no backdated `created_at`), updates only the settle columns, and a trigger allows only reserved to settled or failed, once; afterwards only `on delete set null` may clear a reference.
- The day starts at midnight Europe/Berlin, computed in SQL. The unit is USD, as Bedrock bills.
- The kill switch fails closed: a missing settings row means off; if the server cannot reach the RPC, it does not call the model.
- Usage rows outlive their user, notebook and message (`on delete set null`). After 90 days the user id is removed and aggregates are kept (job with PR F).

## Consequences

- The `service_role` key sits in the request path. It bypasses RLS everywhere, so it is confined to one module that exports only `reserve` and `settle`, enforced by a lint rule and a test (PR E2), and it is not set in Vercel Preview: previews fail closed.
- Limits and the switch change without a deploy, but only through SQL by a human with access to the Supabase project. `service_role` can read them, not change them.
- All reservations share one lock. That is fine at demo traffic; revisit if reservation latency shows up in the p95.
- Stale reservations overcount until midnight, on the safe side.
- Obligations for the caller (PR E2): `p_is_anonymous` comes from the user verified by the Auth server (`getUser()`), with a test; each reservation runs in its own read committed transaction; settle links only the message the server just wrote.

## Alternatives considered

- **`security definer` function in `private`**: needs an ADR 0001 change and a public wrapper `authenticated` can execute, and a user could then settle their own rows.
- **User's JWT with a narrow insert grant on `private.usage`**: breaks the rule that API roles have nothing in `private`, and settling stays forgeable.
- **Dedicated `budget_writer` login role over a direct connection**: least privilege, but a new dependency, a pooler setup and a password managed by hand.
- **Check, then call**: concurrent requests all pass the check before any of them writes.
- **Limits in env vars or Vercel Edge Config**: env vars need a redeploy; Edge Config is a new service and a second read path.
- **Budget in tokens**: output tokens cost several times more than input tokens, and embedding tokens almost nothing.
