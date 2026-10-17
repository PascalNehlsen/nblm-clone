# nblm-clone

> The app is a NotebookLM clone. The real product is the platform around it: infrastructure as code, release gates that roll back by themselves, answer quality that is measured, data isolation proven with real tokens, and AI agents that cannot open the gates themselves.

**Status:** under construction. Scope and milestones are in [`docs/roadmap.md`](docs/roadmap.md).

## What it does

Upload sources (PDF, text, URL) into a notebook, ask questions, and get answers that cite the exact passage. Notebooks can be shared as owner, editor or viewer. The UI is in German.

## How it is built

| Area | Choice |
|---|---|
| App | Next.js on Vercel (Frankfurt) |
| Data | Supabase in Frankfurt: Postgres with pgvector, Auth, private Storage, row level security on every table |
| AI | AWS Bedrock in the EU, reached through OIDC without stored keys |
| Infrastructure | OpenTofu: AWS organization, Cloudflare DNS, GitHub rulesets and environments |
| Delivery | GitHub Actions: plan in the PR, apply and deploy only from CI, staged production deploy with automatic rollback |

## How AI agents are used

Claude Code writes most of the code; Codex reviews every PR. What limits them, and how to check it: [`docs/ai-workflow.md`](docs/ai-workflow.md). Rules for agents and humans: [`AGENTS.md`](AGENTS.md).

## Run locally

Needs Node.js 24 (as in CI and on Vercel) and pnpm (the version is pinned in `package.json`).

```bash
pnpm install
pnpm --filter web dev        # http://localhost:3000

pnpm lint && pnpm typecheck && pnpm test && pnpm build   # what CI runs
```

Database tests need Docker and the local Supabase stack (CLI pinned as a dev dependency):

```bash
export SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_NO_UPDATE_NOTIFIER=1   # CLI telemetry and update check off
pnpm db:start                # images from public.ecr.aws
pnpm test:db                 # pgTAP: catalog checks, each with a negative self-test
pnpm test:rls                # RLS matrix: real sign-ins and JWTs, never the service role
pnpm db:stop
```

GitHub login reads `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` from the environment (names in `.env.example`); the stack also starts without them.

Dependency install scripts are blocked unless `pnpm-workspace.yaml` allows them (`allowBuilds`). The app loads no remote fonts; it uses system fonts.

## Documentation

- [`docs/roadmap.md`](docs/roadmap.md): what is built, what comes next, what is deliberately not built
- [`docs/ai-workflow.md`](docs/ai-workflow.md): sandbox, agent roles, gates
- [`docs/adr/`](docs/adr/): architecture decisions
