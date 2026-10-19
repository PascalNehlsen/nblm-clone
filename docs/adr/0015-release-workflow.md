# 0015: Production releases from a v* tag, one approval, staged deploy, canary, automatic rollback

- Status: accepted
- Date: 2026-10-19

## Context

The roadmap asks for a release process that holds: migrations first, a staged production deploy, a smoke test and a canary question against the exact artifact, promote, and an automatic rollback. Production is the Vercel project `nblm-web` at `app.sec-nblm.dev` (ADR 0013) with its own Supabase project. Vercel and Supabase have no OIDC for deploys and migrations (ADR 0010).

## Decision

- **Trigger and gate**: `.github/workflows/release.yml` runs on a `v*` tag only, in the GitHub environment `production` (one required reviewer, deployment policy tags `v*` only). A tag ruleset lets only the admin create `v*` tags. One job, so one approval.
- **Which commit**: the tagged commit must be on `main` and have a successful `develop.yml` run: production gets what develop already ran.
- **Order**: migration guard, dry run, `db push`; record the deployment the domain points to now (a production deployment of this project); `vercel deploy --prod --skip-domain` (built on Vercel); staged smoke test and the canary (ADR 0014) against that deployment; `vercel promote`; live smoke test.
- **Automatic rollback**: if the live smoke test fails after promote, the job promotes the recorded previous deployment, smokes again and fails, so a human looks.
- **No package cache** in this workflow (a poisoned cache must not reach production).

## Consequences

- A failure before promote never touches the domain; migrations are expand-only, so an app rollback never needs a database rollback.
- The first release needs two runs (runbook): the schema must exist before model settings and the demo template.
- No rollback when promote itself fails or the job is cancelled; by hand.
- The gate is one human, and team-scoped Vercel tokens also reach production from `develop` (ADR 0010).

## Alternatives considered

- **Two jobs (migrate, deploy) with two approvals**: the same human twice.
- **Release from `main` pushes**: no human decision per release.
- **Vercel's own promotion with Git integration**: Git deploys are off by design; CI holds the gates.
