# 0023: An operator-only ops page, fed by service_role aggregate RPCs

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

The roadmap asks for a small ops page: ingestion errors by category, cost per day, p95 latency and the latest eval score. The data spans all users. RLS keeps every user inside their own notebooks, and `private.usage` is not exposed at all, so no user's login can read these aggregates, and none should. The live eval only reported to the GitHub job summary.

## Decision

- **Who:** `/ops` is for users whose `app_metadata` has `ops: true` (set by hand, runbook `ops-access.md`), never anonymous ones. `user_metadata` is never read. The check runs in the route's layout on the user verified with the Auth server. Everyone else gets a real 404.
- **Data:** `public.ops_summary(p_days)` (7 or 30 Berlin days) returns counts and sums only:
  - failed sources per category;
  - cost per day and kind (every row counts, like the budget);
  - p95 latency of settled calls per kind;
  - call counts per status;
  - today's global spend against the limit;
  - the kill switch and limits;
  - the latest eval run.

  There are no user, notebook or model ids and no text.
- **Eval score:** `public.record_eval_run(...)` stores it in `private.eval_runs` after every live eval (develop only, ADR 0017). Recording is fail-soft: it never changes the eval result.
- **Privilege:** both functions are security invoker, with `search_path = ''`, executable only by `service_role`. No security definer, no change to the ADR 0001 allowlist.
- **Code path:** `lib/server/admin/ops.ts` is the third service_role module. It exports only `readOpsSummary` and `recordEvalRun` and calls the RPCs with fetch. Only `lib/server/ops/read.ts` and `lib/server/eval/record.ts` may import it (ESLint plus boundary tests).
- **Rendering:** the page validates the result field by field (`parseOpsSummary`) before rendering it as plain text.

## Consequences

- The operator sees costs and failures without opening the database. The page also enforces the AGENTS.md rule, because every category in `lib/ops/categories.ts` needs a label or a unit test fails.
- Authorization lives in app code, not in RLS: the RPCs trust their caller, so the import boundary is the control. A stolen operator session sees aggregates, not content.
- Production shows no eval score, because the eval runs only on develop.
- Budget refusals of chat calls are not stored yet. They need a change to `reserve_model_call` in its own PR.
- Revisit: alerting on the same aggregates, or a second operator.

## Alternatives considered

- **pg_cron snapshot into a table readable through a JWT claim:** no service_role, but the data is up to 15 minutes stale, revocation waits for token expiry, and the RLS tests could not create an operator.
- **Security definer functions:** forbidden outside the allowlist (ADR 0001).
