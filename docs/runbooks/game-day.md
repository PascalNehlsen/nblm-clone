# Runbook: game day (release rollback)

- Last rehearsed: not yet
- Who: Pascal (Vercel production env, release tag, `production` approval). The host session watches the run and writes the postmortem ([ADR 0025](../adr/0025-game-day-fault-switch.md))
- Effect: `https://app.sec-nblm.dev/login` answers 500 for about 1 to 2 minutes until the automatic rollback. Logged-out visitors cannot sign in during that time; signed-in pages keep working

## Preconditions

- The live release contains the switch (v1.0.4 or later) and is healthy: `/login` answers 200.
- `main` has a green develop run; the game day tags that same commit again.
- Nobody else is releasing. Pick a quiet time.

## Steps

1. Vercel → `nblm-web` → Settings → Environment Variables → add `GAME_DAY_FAULT` = `live-login`, **Production only** (never Preview, never `nblm-web-develop`). Do **not** redeploy: a redeploy would ship the fault without a rollback.
2. Tag the same commit as the live release with the next version and push it:
   `git fetch origin && git tag -s v1.0.N origin/main -m "v1.0.N game day" && git push origin v1.0.N`
3. Approve `production` in the release run. Note the time.
4. Expected run: migration guard and staged smoke green, canary green, promote, **live smoke red** (`live-login GET /login 500 fail: status`, after about 40 to 90 s of retries), **Roll back** promotes the previous deployment, its smoke is green, the run ends red.

## Verify

- The run summary says "Rolled back to dpl_...".
- `curl -sI https://app.sec-nblm.dev/login` answers 200.
- `vercel ls nblm-web` (or the Vercel dashboard) shows the previous deployment as current production.
- Vercel runtime logs for the failed deployment contain `game day fault: live-login`.

## Clean up

- Vercel → `nblm-web` → remove `GAME_DAY_FAULT` (or `vercel env rm GAME_DAY_FAULT production`), then check it is gone.
- The failed tag stays as a record. The next normal release ships again with the variable unset.

## Afterwards

Write `docs/postmortems/<date>-game-day.md` from the run log: timeline, what failed, what worked, what to change. Update "Last rehearsed" above.
