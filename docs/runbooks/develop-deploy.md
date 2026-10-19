# Runbook: deploy main to develop

- Last rehearsed: 2026-10-19, first runs after #38, #39 and #40 (see "Lessons from the first run" below)
- Who: CI only (`.github/workflows/develop.yml`, environment `develop`). The human sets up the projects, secrets and environment below. Nobody migrates or deploys locally ([ADR 0010](../adr/0010-develop-deploy-from-ci.md))
- What: on every push to `main`: migration guard, `supabase db push` to `nblm-develop`, remote build of `nblm-web-develop`, smoke test on the new deployment, promote to `nblm-web-develop.vercel.app`

## Setup before the merge (human, once)

The first push to `main` after the merge runs the workflow. Anything missing makes it fail closed (no deploy), so finish this list first.

**Supabase**

1. Create the project `nblm-develop`: region Central EU (Frankfurt), plan Free, Postgres 17. Generate a long random database password without URL-special characters (letters and digits only) and keep it in your password manager. Send the builder the project ref (not a secret).
2. Project Settings, API keys: note the publishable key (`sb_publishable_...`). Check that JWT signing keys are asymmetric (the app verifies sessions locally with `getClaims()`).
3. Database settings: SSL enforcement on; no network restrictions.
4. Authentication, URL configuration: Site URL `https://nblm-web-develop.vercel.app`; Redirect URLs exactly `https://nblm-web-develop.vercel.app/auth/callback` (no wildcards, no preview URLs).
5. Authentication, Sign In / Providers: Email off; Anonymous sign-ins off (until the Turnstile PR); Captcha off for now.
6. GitHub, Settings, Developer settings, OAuth Apps, New: name `nblm develop`, homepage `https://nblm-web-develop.vercel.app`, callback `https://<ref>.supabase.co/auth/v1/callback`. Generate a client secret.
7. Supabase, Providers, GitHub: on, with that client id and secret. The secret stays in the Supabase dashboard only.
8. Connect, Session pooler: copy the URI (`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-...-eu-central-1.pooler.supabase.com:5432/postgres`), put in the password, append `?sslmode=require`. This is the secret `SUPABASE_DB_URL`. Do not use the direct connection (IPv6 only; GitHub runners have no IPv6).

**Vercel (`nblm-web-develop`)**

9. Settings, Environment Variables, Production only (never Preview or Development): `NEXT_PUBLIC_SUPABASE_URL` = `https://<ref>.supabase.co`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the publishable key, `NEXT_PUBLIC_SITE_URL` = `https://nblm-web-develop.vercel.app` (no trailing slash). `AWS_ROLE_ARN`, `BEDROCK_*` and `ENABLE_EXPERIMENTAL_COREPACK` are already set. Also, Production only and marked Sensitive: `SUPABASE_SECRET_KEY` = the develop project's secret key (`sb_secret_...`, Project Settings, API Keys), needed by the model wrapper for the budget (reserve and settle, ADR 0006); without it every model call fails with "Budgetprüfung nicht erreichbar". `BEDROCK_CHAT_MODEL_ID` = `eu.amazon.nova-2-lite-v1:0` (block D, set 2026-10-19).
10. Settings, Deployment Protection: check that "Protection Bypass for Automation" is available on Hobby and create a secret. **If it is not available, stop and tell the builder**; do not switch to direct deploys (decision 2026-10-19). The secret is `VERCEL_AUTOMATION_BYPASS_SECRET`.
11. Settings, General: note the Project ID (`VERCEL_PROJECT_ID`). Team settings: note the Team ID (`VERCEL_ORG_ID`).
12. Account Settings, Tokens: create `nblm-develop-ci`, scope the team `pascalnehlsens-projects`, expiration 90 days. Put the expiry date in your calendar and in the inventory below. This is `VERCEL_TOKEN`. It can also reach `nblm-web` (accepted, ADR 0010).

**GitHub**

13. Settings, Environments, New: `develop`. Deployment branches: selected branches, add `main`. No required reviewers.
14. Secrets and variables of that environment (on the host; agents are denied `gh secret` and `gh variable`):

```bash
R=PascalNehlsen/nblm-clone
gh secret set SUPABASE_DB_URL --env develop -R "$R"                    # paste, not as an argument
gh secret set VERCEL_TOKEN --env develop -R "$R"
gh secret set VERCEL_AUTOMATION_BYPASS_SECRET --env develop -R "$R"
gh variable set VERCEL_ORG_ID --env develop -R "$R" --body '<team id>'
gh variable set VERCEL_PROJECT_ID --env develop -R "$R" --body '<project id>'
gh variable set DEVELOP_SITE_URL --env develop -R "$R" --body 'https://nblm-web-develop.vercel.app'
gh variable set DEVELOP_SUPABASE_URL --env develop -R "$R" --body 'https://<ref>.supabase.co'
gh variable set DEVELOP_SUPABASE_PUBLISHABLE_KEY --env develop -R "$R" --body '<sb_publishable_...>'
```

15. Check the environment:

```bash
gh api repos/PascalNehlsen/nblm-clone/environments/develop \
  --jq '{r: [.protection_rules[] | .type], b: .deployment_branch_policy}'      # b.custom_branch_policies: true; no required_reviewers
gh api repos/PascalNehlsen/nblm-clone/environments/develop/deployment-branch-policies --jq '[.branch_policies[].name]'   # ["main"]
gh secret list --env develop -R PascalNehlsen/nblm-clone                    # the three secrets
gh variable list --env develop -R PascalNehlsen/nblm-clone                  # the six variables
```

## Every run

1. `migrate`: the run summary shows the pending migrations and the guard result. Then `db push --dry-run` and `db push`.
2. `deploy`: the summary shows the staged deployment URL and the smoke table (path, status, redirect path, pass). Then promote and one check of `https://nblm-web-develop.vercel.app/login`.
3. After the first green run: open the demo, sign in with GitHub, create a notebook. Record the date and run link under "Last rehearsed".

## Rollback

- **Guard fails:** nothing ran. Fix or remove the pending migration in a PR. A destructive (contract) migration needs a PR that changes the guard.
- **Migration fails:** each file runs in its own transaction; earlier files stay applied, the failing one is rolled back. No deploy happens, and the old app keeps working (expand-only). Fix the failing file in a PR (it was never applied, so it may change). Never edit an applied migration; never `db reset` the hosted project.
- **Build or deploy fails:** nothing changed; the domain stays on the previous deployment.
- **Smoke fails:** no promote; the domain stays on the previous deployment. Read the smoke table, fix in a PR. The failed deployment stays unaliased and can be deleted in the Vercel dashboard.
- **Promoted deployment turns out bad:** Instant Rollback in the Vercel dashboard (human). Then fix forward in a PR; the next green run promotes again.
- **Project paused (Free plan):** the migrate step cannot connect. Restore the project in the dashboard and rerun. `synthetic.yml` (not built yet) is meant to keep it awake.

## Secrets inventory and rotation

| Secret | Where | Expires | Rotate |
|---|---|---|---|
| `SUPABASE_DB_URL` | env `develop` | no expiry; rotate every 90 days | Supabase, Database settings, reset password; update the secret; rerun the workflow by hand |
| `VERCEL_TOKEN` | env `develop` | 90 days after creation (fill in the date) | create a new token, update the secret, delete the old token |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | env `develop` | no expiry | regenerate in Deployment Protection, update the secret |

On a leak: revoke first (delete the token, reset the password, regenerate the bypass), then update the secrets.

## After a rehearsal

Update "Last rehearsed" above with the date, the run link and what was deployed.

## Lessons from the first run (2026-10-19)

- **A malformed `SUPABASE_DB_URL` leaked the password once.** psql printed the mangled URL in its error, and GitHub masks only the exact secret value. Since #39 the first migrate step masks the password and the URL and checks the session-pooler form silently; since #40 it lists which part is wrong. If it happened again: rotate the database password, delete the run (`gh run delete <id>`), set the secret again.
- **Set secrets only from a checked value.** Pasting into `gh secret set` twice stored something that was not a URL (whitespace, no scheme). Use `.scratch/check-db-url.sh` (local, git-excluded): it reads the URL hidden, checks every part and sets the secret from exactly that value. The same idea for the bypass secret: `.scratch/set-bypass.sh` checks it against a protected deployment (200) before setting it.
- **Bypass secret mismatch** shows as a staged smoke test with `302` and no app redirect on every page (Vercel's protection page).
- **Supabase Auth URL configuration** is not set by `db push`. With the default Site URL (`http://localhost:3000`) the GitHub login lands on localhost. Set Site URL `https://nblm-web-develop.vercel.app` and the redirect URL for `/auth/callback`.
- **Rerun without a new merge:** `gh run rerun <id>` (all jobs) or `gh run rerun <id> --failed` (only the failed job, e.g. deploy after a fixed bypass secret).

## Demo login (block F2)

Order matters: the staged smoke test requires anonymous sign-in **on** and the captcha **enforced** from F2 on (before F2 it required anonymous sign-in off).
1. Cloudflare, Turnstile, Add widget: name `nblm develop`, hostname `nblm-web-develop.vercel.app`, mode Managed. Keep the site key (public) and the secret key.
2. Supabase develop, Authentication, Attack Protection: captcha on, provider Turnstile, the secret key. The GitHub login is not affected (OAuth needs no captcha).
3. Vercel `nblm-web-develop`, Production: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` = the site key.
4. Register the demo template ([runbook](demo-template.md)).
5. Right before merging F2: Supabase, Authentication, Sign In / Providers, Anonymous sign-ins on.

## Moving develop to develop.sec-nblm.dev (after the Cloudflare apply)

In this order, so nothing is ever pointed at a host that does not answer:
1. Wait until Vercel shows `develop.sec-nblm.dev` as valid (certificate issued).
2. Cloudflare Turnstile widget: add the hostname `develop.sec-nblm.dev`.
3. Supabase develop, URL configuration: add the redirect `https://develop.sec-nblm.dev/auth/callback`; then set the Site URL to `https://develop.sec-nblm.dev`.
4. Vercel `nblm-web-develop`, Production: `NEXT_PUBLIC_SITE_URL=https://develop.sec-nblm.dev`.
5. GitHub environment `develop`: `gh variable set DEVELOP_SITE_URL --env develop --body https://develop.sec-nblm.dev`.
6. Rerun the last develop run (`gh run rerun <id>`), check the smoke results.
7. Only then remove `nblm-web-develop.vercel.app` from the Supabase redirects and the Turnstile hostnames.
