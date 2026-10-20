# 0025: A game day fault switch in the proxy, to prove the release rollback

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

The release pipeline promotes a deployment, smokes the live domain and promotes the previous deployment if that fails (ADR 0015). The rollback had never run for real. The roadmap asks for a game day with a real postmortem. A real failure must get past the staged smoke and the canary and fail only on the live domain, without touching data or infrastructure, and it must be switched off again without a deploy.

## Decision

- **Behaviour:** `lib/server/game-day.ts` and the first lines of `proxy.ts` answer `GET /login` with 500 (fixed German text, `no-store`) and log the fixed line `game day fault: live-login`. They do this only when all three hold:
  - the deployment's env has `GAME_DAY_FAULT=live-login`;
  - the request host is the site's own domain (`NEXT_PUBLIC_SITE_URL`);
  - the path is exactly `/login`.
- **Default:** off for every other value, host or path, and when the site URL is missing. No Supabase call is made when it is on.
- **Why the run behaves as planned:**
  - The staged smoke and the canary use the `*.vercel.app` URL, so they pass.
  - The live smoke on the domain fails.
  - `release.yml` promotes the previous deployment, which was built without the variable.
- **Setting and clearing:** the variable is set only in Vercel `nblm-web`, Production, for the game day, and removed right after (runbook `game-day.md`). The switch stays in the code for later game days.

## Consequences

- The rollback path is exercised for real, with a timeline from the run and the logs (postmortem).
- Anyone who can edit Vercel production env can take login down while the variable is set. That is no new power: every production variable can break the app.
- If the variable is left set, every later release fails its live smoke and rolls back by itself, which is safe but noisy. A manual Vercel "Redeploy" while it is set would break live with no automatic rollback; the runbook warns about this.
- Revisit if the release pipeline changes how it smokes, or if a staging domain is added.

## Alternatives considered

- **A broken commit merged to main:** develop would break too, and the fault would be in the history and need a revert.
- **Failing the staged smoke:** this proves only that a bad build is stopped, not the rollback after promote.
