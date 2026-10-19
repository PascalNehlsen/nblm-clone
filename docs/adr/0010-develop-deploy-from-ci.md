# 0010: develop is migrated and deployed from CI with environment-scoped tokens

- Status: accepted
- Date: 2026-10-19

## Context

develop is the live demo and the only place where the Bedrock call over Vercel OIDC can be tested end to end (ADR 0009). Nothing deploys it yet: Git deploys are off and nobody deploys locally. Migrations must reach the database before the app that needs them (AGENTS.md, expand-contract). AWS is reached through OIDC, but neither Vercel nor Supabase offers OIDC for deploys or migrations from GitHub Actions, so this needs the first long-lived deploy credentials in GitHub.

## Decision

- `.github/workflows/develop.yml` runs on every push to `main` (and by hand on `main`), in the GitHub environment `develop`: deployment branches `main` only, no required reviewer (the human's merge is the gate). One concurrency group, never cancelled.
- Job `migrate`: reads the applied versions read-only, `scripts/migration-guard.mjs` fails on drift, out-of-order versions and destructive statements in pending migrations (no override in v1), then `supabase db push --db-url` with a dry run first. Never seed, reset or `--include-all`.
- Job `deploy`, only after `migrate`: `vercel deploy --prod --skip-domain` builds remotely on Vercel (env vars never reach the runner), `scripts/smoke.mjs` checks the new deployment through the protection bypass, and only then `vercel promote` moves the domain. A failed smoke test leaves the domain on the previous deployment.
- Credentials, all in `develop`, passed only to the step that uses them:
  - `SUPABASE_DB_URL`: session pooler URL of the develop database. It reaches only that database (as `postgres`); a Supabase personal access token would reach every project and the organization, so it is not used.
  - `VERCEL_TOKEN`: team-scoped, 90-day expiry. Vercel cannot scope a token to one project, so it can also deploy to and read env vars of `nblm-web` (production). Accepted for v1; `production` gets its own token.
  - `VERCEL_AUTOMATION_BYPASS_SECRET`: project-scoped, only lets the smoke test past deployment protection.
- The `develop` environment requests no `id-token`, so it never gets an AWS role.

## Consequences

Every merge reaches the live demo within minutes, migrations first, and a broken build or failed smoke test never takes the demo down. The cost is two deploy credentials in GitHub that rotate by hand every 90 days (runbook), a Vercel token whose reach includes production, and a `postgres` connection to develop from CI. A destructive (contract) migration needs a PR that changes the guard. Revisit when Vercel or Supabase offer OIDC or project-scoped tokens, when the release workflow adds `production`, or if the token's reach over `nblm-web` is no longer acceptable.

## Alternatives considered

- **Supabase personal access token with `supabase link`**: account-wide, reaches production and organization settings.
- **Build on the runner (`vercel pull` + `build` + `--prebuilt`)**: writes the project's env vars, including secrets, to the runner. Fallback only if Vercel cannot build with pnpm 12.
- **Direct `--prod` deploy and manual rollback**: the demo serves a broken build until a human acts.
- **Required reviewer on `develop`**: every merge would wait twice for the same human.
