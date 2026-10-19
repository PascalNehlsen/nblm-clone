# Runbook: release to production

- Last rehearsed: never; the first `v*` tag after the production setup below is the first run
- Who: the human creates the tag and approves the `production` environment; CI does the rest (`.github/workflows/release.yml`, ADR 0014). Nobody deploys or migrates production locally
- What: tag on main, green on develop, then migrations, a deployment without the domain, smoke test and canary against exactly that deployment, promote to `app.sec-nblm.dev`, live smoke test, automatic promote of the previous deployment if the live check fails

## Production setup (once, before the first tag)

**Supabase**: a new project `nblm-production` (Frankfurt, Postgres 17, plan Free: no backups, pauses after 7 idle days), database password of letters and digits only, asymmetric JWT keys, SSL enforced. Authentication: Site URL `https://app.sec-nblm.dev`, redirect exactly `https://app.sec-nblm.dev/auth/callback`, Email off, GitHub provider with a new OAuth app `nblm production` (callback `https://<ref>.supabase.co/auth/v1/callback`), captcha on (Turnstile, a widget for the hostname `app.sec-nblm.dev`). Anonymous sign-ins: see "First release" below.

**Canary account**: Authentication, Users, Add user (an email such as `canary@sec-nblm.dev`, no password kept anywhere). Its id is `CANARY_USER_ID`. It owns nothing and never signs in.

**Vercel `nblm-web`**, Production only: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL=https://app.sec-nblm.dev`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; sensitive: `SUPABASE_SECRET_KEY`, `CANARY_SECRET` (32+ random letters and digits), and `CANARY_USER_ID`. `AWS_ROLE_ARN`, `BEDROCK_*` are set. Deployment Protection: Protection Bypass for Automation (its secret is the GitHub secret below). A team token `nblm-production-ci`, 90 days.

**GitHub environment `production`** (required reviewer, tags `v*` only; tag ruleset `release-tags` lets only the admin create `v*`):
- Secrets: `SUPABASE_DB_URL` (session pooler, set with `.scratch/check-db-url.sh` adapted to `--env production`), `VERCEL_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `CANARY_SECRET` (same value as in Vercel).
- Variables: `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (of `nblm-web`), `PRODUCTION_SITE_URL=https://app.sec-nblm.dev`, `PRODUCTION_SUPABASE_URL`, `PRODUCTION_SUPABASE_PUBLISHABLE_KEY`.

## First release (once)

A fresh project has no schema, so model settings and the demo template cannot exist before the first tag. The first release is therefore run twice:
1. Tag and approve. The run applies every migration, then **stops before promote**: the staged smoke test fails while anonymous sign-ins are off (it requires them on), or the canary fails while model features are off (the migration seeds them off). Nothing gets the domain.
2. In this order, on the production project: register the demo template (runbook `demo-template.md`), turn **model features on** (runbook `kill-switch.md`, "Turn model features on"), turn **anonymous sign-ins on** (the captcha is already enforced).
3. `gh run rerun <id>` and approve again. The migrations are a no-op now; smoke test, canary, promote and live check run through.

## Release

1. The commit to release has a **successful develop run** (a queued develop run that GitHub replaced does not count; tag a commit develop actually ran).
2. `git tag -s v1.0.0 <sha> -m "v1.0.0"` and `git push origin v1.0.0` (only the admin may create `v*`).
3. Approve `production` in the run. Read the job summary: migration guard, dry run, staged smoke, canary (four checks), live smoke.

## When it fails

- Before promote (guard, migrations, smoke, canary): nothing changed for users; the new deployment never got the domain. Migrations that ran stay (expand-only).
- Live smoke after promote: the job promotes the previous deployment by itself, smokes again and fails. Check the summary; on the first release there is no previous deployment.
- No automatic rollback when `vercel promote` itself fails or the job is cancelled or times out; then by hand.
- By hand: `vercel promote <deployment id> --scope <team>` with the production token, or Vercel's Instant Rollback.

## What the gate does not cover

- One human tags and approves (`production` has one reviewer, the admin who may create `v*` tags).
- Vercel tokens are team tokens: the develop token (environment `develop`, no reviewer) can also deploy and promote `nblm-web`, and the production token reaches `nblm-web-develop`. Accepted in ADR 0010; the `production` approval gates this workflow, not every holder of a team token.
- Git auto-deploys must stay off for `nblm-web` (`apps/web/vercel.json`).

## Secrets inventory and rotation

| Secret | Where | Expiry | Rotate |
|---|---|---|---|
| `VERCEL_TOKEN` (production) | GitHub `production` | 90 days | new token, `gh secret set VERCEL_TOKEN --env production` |
| `SUPABASE_DB_URL` | GitHub `production` | none | reset the database password, set again |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel `nblm-web`, GitHub `production` | none | new bypass secret in Vercel, set in GitHub |
| `CANARY_SECRET` | Vercel `nblm-web`, GitHub `production` | none | new value in both |
