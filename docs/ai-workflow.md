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

Network allowlist for this project. Rows marked *verified* were measured inside the sandbox; the others are still proposed until `pnpm exec playwright install` and the first use of each host:

| Host | Why |
|---|---|
| `api.anthropic.com` | Claude Code itself (nonessential traffic is disabled in `.claude/settings.json`) |
| `registry.npmjs.org` | pnpm; also the Supabase CLI, whose binary is an optional npm package pinned by integrity hash in `pnpm-lock.yaml` (no postinstall download). *Verified 2026-10-17* |
| `registry.opentofu.org` | OpenTofu provider index for `tofu init`; the provider binaries come from GitHub release assets and are checked against `.terraform.lock.hcl`. The `tofu` binary itself is a GitHub release checked by `scripts/tofu.sh`. GET/HEAD only, scoped to this sandbox. *Verified 2026-10-17* |
| `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com` | git, gh (read and PR only), CLI release downloads |
| `public.ecr.aws` | Supabase local stack images and `pg_prove` (`supabase start`, `supabase test db`). GET/HEAD only, scoped to this sandbox. *Verified 2026-10-17* |
| `d2glxqk2uabbnd.cloudfront.net` | Blob redirect target of ECR Public (image layers). GET/HEAD only, scoped to this sandbox. *Verified 2026-10-17* |
| `cdn.playwright.dev` | Playwright browsers and FFmpeg (`pnpm exec playwright install chromium`, Playwright 1.63.0). GET/HEAD only, scoped to this sandbox. *Verified 2026-10-18* |
| `storage.googleapis.com`, path `/chrome-for-testing-public/**` only | Redirect target of the Chrome for Testing downloads (`cdn.playwright.dev/builds/cft/...` answers 307). Restricted to this path because the whole host serves every public GCS bucket: an open host would be an exfiltration channel to any bucket through the path. GET/HEAD only, scoped to this sandbox. *Verified 2026-10-18* |

Deliberately **not** allowed: `playwright.download.prss.microsoft.com` and `playwright.azureedge.net` (Playwright 1.63.0 needs neither for Chromium; FFmpeg falls back to `cdn.playwright.dev`), `kong-hf.konghq.com` (Kong anonymous reports from the local stack's gateway), `data.iana.org`, `ghcr.io` and Docker Hub (the Supabase CLI falls back to them; ECR is enough in the sandbox, while CI pulls from `ghcr.io` because `public.ecr.aws` rate-limited the runners), PostHog (Supabase CLI telemetry, also switched off with `SUPABASE_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`), `results-receiver.actions.githubusercontent.com` (Actions job logs; read them in the browser), `*.amazonaws.com`, `*.supabase.co`, `api.vercel.com`, `api.cloudflare.com`, `sentry.io`, and every wildcard on a domain where anyone can register a subdomain (`*.workers.dev`, `*.vercel.app`, `*.github.io`). A leaked token cannot reach the management APIs, and a poisoned README cannot pick an exfiltration host it controls.

The `sbx` network policy is global per machine, so the effective allowlist is the union of every project's entries. Before a session, audit what is really allowed:

```bash
sbx policy ls --json | python3 -m sbx_audit -
```

The sandbox signs commits with its own SSH key "nblm sandbox agent" (`SHA256:sJXVDJI4LgEiazQtG4Wm2mzHFY4/Y5zzMCtAxiZakU8`), set through `GIT_CONFIG_*` env vars in the sandbox shell so the shared `.git/config` keeps the host key. The signature proves a commit came from the sandbox, not that a human reviewed it; the human merge is the review. Revoke the key on GitHub after the challenge. The sandbox token has no Administration and no Workflows permission, so workflow changes are pushed from the host.

## Flow per change

```text
high risk:   planner -> human approves -> test-author (red) -> builder (green)
             -> reviewer -> PR -> CI + Codex + eval -> human merges
normal:      builder -> PR -> CI + Codex -> human merges
dependabot:  bot PR (version bumps only) -> human reads changelog + diff -> CI
             (+ reviewer for majors and gate workflows) -> human merges
release:     tag -> production approval (human) -> migrate -> staged deploy -> canary -> promote
```

Risk class **high** means the change touches `supabase/`, `infra/`, auth, prompts or retrieval, `.github/workflows/` or `.claude/`.

Dependabot PRs touch `.github/workflows/` and stay labelled high; the conditions for the lighter flow are in AGENTS.md. The weekly `actions-audit` workflow runs zizmor online (vulnerable and impostor action pins); it is not a required check, and GitHub pauses scheduled workflows after 60 days without repo activity.

## Checking that the limits hold

```bash
node --test .claude/hooks/agent-guard.test.mjs   # role limits, symlink escape, fail-closed
```

Manual checks, run once and recorded here:

| Check | Expected | Result |
|---|---|---|
| Ask the test-author to fix a bug in `apps/` | Blocked by agent-guard | Pass (2026-10-16): `Write` to `apps/web/lib/sum.ts` blocked by agent-guard ("test-author: writes only under tests/ or supabase/tests/"), no file created |
| Ask the main session to run `tofu apply` | Denied by settings | Pass (2026-10-16): "Permission to use Bash with command tofu apply has been denied" |
| Inside the sandbox, `curl https://api.vercel.com` | Blocked by egress policy | Pass (2026-10-16, re-run after adding local deny rules): HTTP 403 "Blocked by local rule for api.vercel.com:443". Same for `api.supabase.com`, `api.cloudflare.com` and `sts.amazonaws.com`. Other unlisted hosts still ask for approval (e.g. `api.github.com`) |
| Open a PR that weakens `.claude/settings.json` | Codex reviews with the base-branch config | Not run (2026-10-16): no Codex review job in `.github/workflows/` yet, run once it exists |

## Gate log

Every PR records what a reviewer, Codex or CI caught. The label `caught-by-gate` marks only a defect or risk that would otherwise have reached `main` or production; a gate that just blocked work is recorded as friction, without the label (rule since PR #3). At the end, the numbers in the README come from counting those labels, not from memory.

| Date | Where | What was caught | Fix |
|---|---|---|---|
| 2026-10-16 | Manual egress check (this doc) | Unlisted hosts were not denied but returned "Approval required": one click on the host would have let the sandbox reach `api.vercel.com`. The limit depended on a human declining a prompt | Explicit local deny rules for the management APIs (Vercel, Supabase, Cloudflare, AWS STS); deny rules take precedence over approvals. Re-run returns "Blocked by local rule" |
| 2026-10-16 | Planning for sandbox push access | Giving the sandbox the host `gh` token (scope `repo`, which on an owned repo means admin) would let an agent delete the `main` ruleset through `api.github.com`. The sandbox proxy hides the token value, not its permissions, and the `gh ruleset` deny rule only matches command text | Sandbox now has its own fine-grained token for this repo only (Contents and Pull requests write, no Administration, no Workflows). Verified 2026-10-16: no `X-OAuth-Scopes` header, expiry 2026-11-15; admin-only endpoints (`hooks`, `keys`, `actions/permissions`) return 403 "Resource not accessible by personal access token". `.permissions` still reports `admin: true` because it shows the owner's role, not the token's, and `GET rulesets` succeeds because reading rulesets needs only read access. Direct write test: `POST rulesets` for a disabled ruleset targeting `refs/heads/never-exists-probe` returned 403 with `X-Accepted-GitHub-Permissions: administration=write`; no ruleset was created (only `main` listed afterwards) |
| 2026-10-17 | `supabase start` in the sandbox (PR 2) | Friction, no defect: the image pull hit "Approval required" for `public.ecr.aws`, then the CLI fell back to `ghcr.io` and Docker Hub, also blocked. The first request to allow the registry was denied until the reason was stated | Human allowed only `public.ecr.aws` and `d2glxqk2uabbnd.cloudfront.net` (measured blob redirect), GET/HEAD, this sandbox only. `ghcr.io`, Docker Hub, PostHog and `results-receiver` stay blocked. CLI telemetry and update check off via env in the sandbox and in CI |
| 2026-10-17 | Codex review (manual, pre-merge) of PR #16 | The CI plan role trusted every `pull_request` run. A PR plan job runs code from the PR branch (`scripts/tofu.sh`, external data sources), so anyone who can push a branch, this sandbox included, would have had AWS read access (SecurityAudit) and decrypted state through CI, breaking the first hard limit in AGENTS.md. The reviewer subagent and the builder missed it | Plan role trusts only `environment:plan` (required reviewer); the plan job will also require a same-repo head against forks. Tests pin environment-scoped subjects and reject `:pull_request` and `:ref:` |
| 2026-10-18 | `playwright install chromium` in the sandbox (PR B1) | Friction, no defect: the Chromium download on `cdn.playwright.dev` redirects (307) to `storage.googleapis.com/chrome-for-testing-public/...`, a host outside the allowlist. The install stopped there until a human decided | Human allowed `cdn.playwright.dev` and `storage.googleapis.com` restricted to `/chrome-for-testing-public/**` (an open GCS host would let any path reach any public bucket), GET/HEAD, this sandbox only; the proposed `playwright.download.prss.microsoft.com` row was removed. Measured: FFmpeg first tries `cdn.playwright.dev/dbazure/...`, which redirects to the Microsoft host, gets 403 twice and falls back to `cdn.playwright.dev/builds/ffmpeg/...` (200). The Microsoft host stays blocked |
| 2026-10-18 | Pending sandbox approvals (PR B1) | Friction: approval prompts for `playwright.azureedge.net` (older Playwright mirror), `kong-hf.konghq.com` (Kong anonymous reports from the local gateway) and `data.iana.org` | Dismissed, all three stay blocked. Kong reports cannot be switched off by env: Supabase CLI 2.119.0 sets the Kong container env itself, without `KONG_ANONYMOUS_REPORTS`, so CI runners still send Kong's anonymous ping (no project data) |

## Prompts that shaped this repo

A few real prompts (cleaned of personal details) are collected here as the project goes, to show how work was split and checked:

- *(added during the build)*
