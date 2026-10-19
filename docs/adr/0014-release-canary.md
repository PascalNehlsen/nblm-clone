# 0014: The release canary asks one real question as a fixed server-configured account

- Status: accepted
- Date: 2026-10-19

## Context

The release workflow (R3) deploys a new production build without a domain, checks it, and only then promotes it. Page smoke tests do not show whether the model path works: Vercel OIDC to the AWS role, Bedrock embeddings and chat, prices, the budget RPCs, the kill switch, the citation check. A real check needs a model call, and every model call needs a budget subject (ADR 0006). CI cannot hold a user session: the GitHub login is OAuth, the demo login is behind the captcha, and an admin-made session would put the `service_role` key into CI.

## Decision

- **Endpoint** `POST /api/canary` (route `app/api/canary/route.ts`, logic in `lib/server/canary/`): off (404) unless `CANARY_SECRET` and `CANARY_USER_ID` are set; the header `x-canary-secret` is compared in constant time; no request body is read; the response is `{ ok, checks }` with four booleans, never model text. Public path in the proxy (no session); the secret protects it.
- **Check**: one embedding of a fixed German question and one chat turn through `runTurn` with a fixed in-code passage (fictional facts, no database read or write besides usage rows). It passes only if the embedding has 1024 finite values, the turn answers, every citation is an exact quote of the passage, and the answer is not the abstention sentence.
- **Budget subject**: `createCanaryCaller` in `lib/server/model/call.ts` binds the same budgeted wrapper as `createModelCaller`, but its user is `{ id: CANARY_USER_ID, isAnonymous: false }` from the environment. This is an exception to ADR 0006 ("no caller can choose the user"): the id is still not a parameter; only the server's configuration chooses it. The canary account is an ordinary user created by hand, without a password, owning nothing.
- **Script** `scripts/canary.mjs`: calls the staged deployment with the bypass and canary headers, retries once only after a network error, timeout or 5xx, prints the four booleans, exits 1 unless all pass.

## Consequences

- A release proves the model path of the exact build before users see it; about 0.1 cent per release, counted against the canary account's budget, the global budget and the kill switch (the kill switch off fails the canary, so a release cannot ship while model features are off by accident).
- Retrieval and database writes are not canaried; CI's full stack and develop cover them.
- A leaked `CANARY_SECRET` lets someone spend the canary account's daily budget, which also blocks releases until the secret is rotated (Vercel and GitHub) or the day rolls over.
- The usage rows are booked without a notebook and without a message (`private.usage` has foreign keys on both), and the canary account must exist in `auth.users` of the production project (the user id has a foreign key too): the release runbook creates it first.

## Alternatives considered

- **A real session in CI**: needs a password or OAuth login (captcha, no OAuth in CI) or a `service_role`-made session in CI.
- **Smoke tests only**: miss every failure behind the model wrapper.
- **Canary on the live domain after promote**: users would already see a broken build.
