# How AI agents work in this repo

Claude Code writes most of the code here, and Codex reviews every PR. This page explains what the agents may do, what stops them, and how to check that the stops work. The rules themselves are in [`AGENTS.md`](../AGENTS.md).

## The idea in one paragraph

Agent rules are written as instructions, and instructions fail ([background](https://pascal-nehlsen.de/blog/agent-gate-it-cannot-open)). So every limit that matters sits outside the agent. The sandbox has no cloud credentials, so the agent cannot deploy or apply. Branch rulesets stop it from merging. The production environment needs a human. Inside those walls, the subagent roles and the permission rules catch the common mistakes early and cheaply.

## Layers

| Layer | What it does | What it does not do |
|---|---|---|
| 1. Sandbox (`sbx`) | Own microVM; only this repo is mounted; outbound network limited to an allowlist; no AWS, Vercel, Supabase, Cloudflare or GitHub admin tokens inside | Stop data from leaving through an allowed host; there the model is the only control ([measured here](https://pascal-nehlsen.de/blog/sandbox-holds-model-stops-leak)) |
| 2. Permission rules (`.claude/settings.json`) | Deny reading secret files and running apply, deploy, migration push and force push; ask before push and before editing guardrail files | Catch every spelling of a command; Claude Code documents Bash rules as not a security boundary |
| 3. Subagent roles (`.claude/agents/` + `agent-guard.mjs`) | planner reads only; test-author writes only tests; reviewer reads and runs read-only git | Make a test file harmless when it runs, or stop the main session |
| 4. Gates outside the agent | Rulesets (PR required, status checks, linear history, no bypass), CODEOWNERS, `production` environment approval, apply and deploy only in CI via OIDC | Judge whether a change is a good idea; that is the human's job |
| 5. Independent review | Codex reviews every PR in CI (different model, different vendor); restores agent config from the base branch, so a PR cannot weaken its own review | Replace the human merge decision |

The reviewer subagent is the same model family as the builder with a fresh context and fewer tools. It is useful, but it is not independent. The Codex review in CI is the independent one.

Models are set per role, not left to the session: `planner` and `reviewer` run on Opus, because a weak plan or a weak review costs more than the tokens; `test-author` runs on Sonnet, because the plan already names every test case. Aliases are used on purpose, so roles move to the newest model of their tier.

## Sandbox setup

```bash
sbx create --name nblm-clone claude .
sbx run --name nblm-clone claude
```

Network allowlist for this project (**proposed, verify on day 1** with `pnpm install`, `supabase start` and `pnpm exec playwright install`, then update this table):

| Host | Why |
|---|---|
| `api.anthropic.com` | Claude Code itself (nonessential traffic is disabled in `.claude/settings.json`) |
| `registry.npmjs.org` | pnpm |
| `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com` | git, gh (read and PR only), CLI release downloads |
| `public.ecr.aws` | Supabase local stack images |
| `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` | Playwright browsers |

Deliberately **not** allowed: `*.amazonaws.com`, `*.supabase.co`, `api.vercel.com`, `api.cloudflare.com`, `sentry.io`, and every wildcard on a domain where anyone can register a subdomain (`*.workers.dev`, `*.vercel.app`, `*.github.io`). A leaked token cannot reach the management APIs, and a poisoned README cannot pick an exfiltration host it controls.

The `sbx` network policy is global per machine, so the effective allowlist is the union of every project's entries. Before a session, audit what is really allowed:

```bash
sbx policy ls --json | python3 -m sbx_audit -
```

## Flow per change

```text
high risk:   planner -> human approves -> test-author (red) -> builder (green)
             -> reviewer -> PR -> CI + Codex + eval -> human merges
normal:      builder -> PR -> CI + Codex -> human merges
release:     tag -> production approval (human) -> migrate -> staged deploy -> canary -> promote
```

Risk class **high** means the change touches `supabase/`, `infra/`, auth, prompts or retrieval, `.github/workflows/` or `.claude/`.

## Checking that the limits hold

```bash
node --test .claude/hooks/agent-guard.test.mjs   # role limits, symlink escape, fail-closed
```

Manual checks, run once and recorded here:

| Check | Expected | Result |
|---|---|---|
| Ask the test-author to fix a bug in `apps/` | Blocked by agent-guard | not run yet |
| Ask the main session to run `tofu apply` | Denied by settings | not run yet |
| Inside the sandbox, `curl https://api.vercel.com` | Blocked by egress policy | not run yet |
| Open a PR that weakens `.claude/settings.json` | Codex reviews with the base-branch config | not run yet |

## Gate log

Every PR records what a reviewer, Codex or CI caught. Real defects get the label `caught-by-gate`. At the end, the numbers in the README come from counting those labels, not from memory.

## Prompts that shaped this repo

A few real prompts (cleaned of personal details) are collected here as the project goes, to show how work was split and checked:

- *(added during the build)*
