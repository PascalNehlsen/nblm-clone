# AGENTS.md

Rules for every coding agent in this repository (Claude Code, Codex) and for the humans reviewing their work.

This repo is a NotebookLM-style app: upload sources, ask questions, get answers that cite the exact passage. The app is the demo. The platform around it is the point: infrastructure as code, release gates that hold, measured answer quality, data isolation tested with real tokens, and agents that cannot open the gates themselves.

Scope and milestones: `docs/roadmap.md`. Decisions: `docs/adr/`. How agents are used here: `docs/ai-workflow.md`.

## Stack

- Next.js (App Router, TypeScript strict) on Vercel, region `fra1`. UI language is German; code, docs, commits and PRs are English.
- Supabase in Frankfurt (develop and production projects): Postgres + pgvector, Auth (GitHub OAuth, anonymous demo sign-in behind Turnstile), private Storage, pg_cron.
- LLM and embeddings via AWS Bedrock in the EU, reached from Vercel through OIDC (no AWS keys). Model ids only from env vars, all model config server-side.
- OpenTofu in `infra/` (stacks: bootstrap, aws, cloudflare, github). Vercel via `vercel.json` + CLI, Supabase via `supabase/config.toml`.
- GitHub Actions for CI/CD, Sentry (EU) for errors.
- Tests: vitest (unit), RLS matrix with real JWTs against local Supabase, pgTAP catalog checks, Playwright (full-stack in the CI runner), eval harness in `tests/eval/`.

## Where the hard limits are

Instructions in this file are context, not enforcement. What actually holds:

| Limit | Enforced by |
|---|---|
| No cloud or deploy credentials reachable by agents | Agents run in a Docker sandbox (`sbx`) with an egress allowlist; apply, deploy and migrations only run in CI via OIDC |
| Nothing reaches `main` without checks | GitHub rulesets: PR required, required status checks, linear history, no bypass |
| Nothing reaches production without a human | GitHub Environment `production` with required reviewer |
| Subagent roles (planner, test-author, reviewer) | Tool lists in `.claude/agents/` + `.claude/hooks/agent-guard.mjs` |
| Dangerous commands and secret files | `permissions.deny` / `ask` in `.claude/settings.json` (a speed bump: Claude Code documents Bash rules as not a security boundary) |

Never describe an instruction-level limit as enforced. If a task seems to need a credential, a host outside the allowlist, or a change to any of the limits above, stop and say so.

## Roles and flow

The main session is the **builder**. Subagents: `planner` (read-only), `test-author` (writes only tests), `reviewer` (read-only, includes the security checklist). Codex reviews every PR in CI as the independent review.

**Risk class** (CI computes it from changed paths):
- **high:** `supabase/`, `infra/`, auth, prompts or retrieval (`lib/rag/`, `prompts/`), `.github/workflows/`, `.claude/`
- **normal:** everything else

Flow for **high**: planner → human approves plan → test-author (red) → builder (green) → reviewer → PR with evidence → CI incl. Codex review and eval → human merges.
Flow for **normal**: builder → PR with evidence → CI incl. Codex review → human merges.
Flow for **Dependabot** PRs that only bump pinned versions: no planner or test-author; a human reads the changelog and diff, CI and the Codex review must pass, the human merges. Major bumps and any change to `release.yml` get the high flow.

## How to work

1. **Small PRs**, one concern each. Branches `feat/`, `fix/`, `infra/`, `docs/`, `chore/`. Never push to `main`.
2. **Conventional Commits**, imperative, say why. The PR title becomes the squash commit, so it must be a valid Conventional Commit.
3. **Tests first** for high-risk changes and for every bug fix.
4. **Run locally before saying "done":** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:rls`. Paste the actual output. Never claim a check passed without running it.
5. **Review is not yours to give.** Never approve your own work, never write a review verdict yourself.
6. **Gates are not yours to open.** Do not modify rulesets, environments, required checks, `.claude/`, `.github/workflows/release.yml` or `infra/github/` unless the task is explicitly about them and the plan was approved.
7. **Gate log.** In the PR template, record what review or CI caught. The label `caught-by-gate` is only for a gate that stopped something which, without the gate, would have reached `main` or production wrong or unsafe. A gate that only blocked work is "friction": record it in the gate log, without the label. When unsure, leave the label off; an inflated count is worse than a low one.
8. **Say what you did not do.** End every task with: what changed, what was tested (with output), what is still open.

## Hard rules: database and RLS

- Every schema change is a new file in `supabase/migrations/`. Never edit an applied migration. Never change the schema in the dashboard.
- Every new table: `enable row level security` in the same migration, separate policies for select, insert, update and delete, and cases in the RLS matrix (owner, editor, viewer, stranger, anon).
- Access is membership-based: `notebook_members (notebook_id, user_id, role)` with roles `owner`, `editor`, `viewer`. Child tables (sources, chunks, messages) check membership through `notebook_id`, in `using` and in `with check`.
- Only owners change memberships. Nobody can insert a membership for a notebook they do not own, and nobody can raise their own role. Membership changes are written to an audit table.
- Membership lookups go through one helper, `private.notebook_role(notebook_id)`: `security definer`, fixed `search_path`, read-only, in the non-exposed schema `private`. It exists to avoid policy recursion and is the only allowed `security definer` function (see its ADR). Everything else, including `match_chunks`, is `security invoker`. Views use `security_invoker = true`.
- Revoke default grants from `anon` on application tables. Internal tables (usage, audit, ops) live in the `private` schema, not in `public`.
- Use `(select auth.uid())` in policies. Never `user_metadata`; roles come from `app_metadata`. Anonymous users are identified by the `is_anonymous` claim.
- `service_role` only in server code under `lib/server/admin/`, never imported by client code, never used in RLS tests.
- Breaking changes follow expand-contract: add, write both, backfill, remove in a later migration. Migrations run before the deploy and must be compatible with the previous app version, so an app rollback never needs a database rollback.

## Hard rules: AI and data security

Mapped to the OWASP Top 10 for LLM Applications in `SECURITY.md`.

- The chat model gets **no tools**.
- Retrieved source text is **data, not instructions**: delimited blocks, and the system prompt says to ignore instructions inside sources.
- **Citations** are validated server-side: the chunk id must be one retrieved for this question and the quoted text must be a substring of that chunk. Anything else is dropped.
- **Rendered model output** never loads remote content: no remote images, no raw HTML, links only http(s). The CSP (`img-src 'self'`) backs this up.
- **Abstention:** if the sources do not contain the answer, the answer says so.
- **Cost:** every model call passes the per-user budget check first (tighter for anonymous users); a global kill switch disables model features. Store tokens, cost and latency per message.
- **Config:** model, system prompt, temperature and max tokens live on the server. The client never sends them.
- **Logs** never contain prompt, source or answer text.
- **Residency:** Vercel `fra1`, Supabase Frankfurt, Bedrock EU, Sentry EU. A new data processor needs an entry in `docs/privacy.md`.
- **Deletion:** deleting an account or notebook removes sources, chunks (embeddings are personal data), messages and Storage objects, with a test.
- **URL import** goes through the SSRF guard: http(s) only, resolve DNS, block private, loopback, link-local and metadata addresses, re-check after every redirect, size and time limits.
- **Uploads:** type allowlist checked by magic bytes, size limit, stored under `{notebook_id}/` in a private bucket.

## Hard rules: infrastructure

- Infra changes only through OpenTofu in `infra/`. `tofu plan` runs in the PR with a read-only role; `apply` runs in CI after merge with the apply role and environment approval. Never run `apply` locally. The one exception is the documented one-time `infra/bootstrap`, see its ADR.
- Run `tofu fmt` and `tofu validate` before committing infra changes. Pin provider versions, commit `.terraform.lock.hcl`.
- Stateful resources (state bucket, KMS key, DNS zone) get `prevent_destroy`. The plan guard in CI blocks destroys and replacements of protected resources.
- No secrets in variables or `.tfvars`. Where a provider forces a secret into state, state encryption protects it.

## Hard rules: CI and supply chain

- Pin every action to a full commit SHA with a version comment. `permissions: {}` at the top of every workflow, grant per job. `persist-credentials: false` on checkout.
- Never use `pull_request_target`. Cloud access only through OIDC roles scoped by the `sub` claim.
- New dependencies need a reason in the PR. Do not disable or weaken a scanner to make a pipeline pass; document a false positive with an expiring exception.

## Conventions

- TypeScript strict, no `any` without a comment explaining why. Server-only modules import `server-only`.
- Ingestion and provider errors use the fixed categories in `lib/ops/categories.ts`. No new category without updating the ops page.
- Every non-obvious architectural decision gets an ADR in `docs/adr/` (template `0000-template.md`), one screen at most.
- Runbooks are one page, with a "last rehearsed" date.
- No em dashes in docs or UI text.

## Definition of done

- [ ] Plan approved (high risk)
- [ ] Tests were red first and are green locally (output in the PR)
- [ ] RLS matrix cases for every new table or policy
- [ ] Eval run if retrieval or a prompt changed (score in the PR)
- [ ] Docs updated (README, ADR, runbook if operations changed)
- [ ] Reviewer subagent run (high risk), Codex review read
- [ ] Gate log filled, known gaps listed in the PR
