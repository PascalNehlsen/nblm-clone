<!-- The PR title becomes the squash commit: use a Conventional Commit, e.g. `feat(rag): validate citations server-side`. -->

## What and why

<!-- One or two sentences. Link the issue or roadmap item. -->

## Risk class

- [ ] **high**: touches `supabase/`, `infra/`, `.github/`, `.claude/`, `scripts/`, gate tests (`tests/rls/`, `tests/ci/`), prompts or retrieval, `apps/web/lib/server/`, auth, a rule file or security config (full list in AGENTS.md; the `Risk class` notice and summary of the `risk class` job show the computed class)
- [ ] **normal**

High risk: link the approved plan and confirm the tests were red before the implementation.

Plan approved by: <!-- host session (within its limits in AGENTS.md) or human -->

Codex reviewed head: <!-- SHA -->

## Evidence

<!-- Paste real output, not "tests pass". -->

```text
pnpm lint && pnpm typecheck && pnpm test && pnpm test:rls
```

Eval score (if retrieval or a prompt changed):

## Gate log

<!-- What did the reviewer subagent, the Codex review or CI catch in this PR? Write "nothing" if nothing.
     Add the label `caught-by-gate` only if, without the gate, something wrong or unsafe would have reached
     main or production. A gate that only blocked work is friction: list it here, no label. -->

| Gate | Finding | Real defect? | Fixed in |
|---|---|---|---|
|  |  |  |  |

## Rollout and rollback

<!-- Migration: expand-only? backward compatible with the current app version? Backout?
     Infra: expected plan (add/change/destroy)? How to revert? -->

## Not done / known gaps

-
