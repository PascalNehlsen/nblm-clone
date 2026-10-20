# Roadmap

The goal is a small app built the way a production platform should be: a demo that works every time, data isolation proven with real tokens, a release process that rolls back by itself, and a hardened server. Anything that does not serve those goals is listed under "Deliberately not built", with the reason.

## v1

**App**
- Notebooks shared with roles (owner, editor, viewer)
- Sources: PDF, pasted text, URL (with an SSRF guard)
- Chunking, embeddings and vector search per notebook
- Streaming chat that answers only from the sources, with citations checked on the server and a click-through to the passage
- Notebook summary and three suggested questions
- One-click demo login (anonymous, behind Turnstile, a personal copy of a demo notebook, deleted after 24 h) and GitHub login
- Per-user daily budget, a global kill switch, account deletion that removes embeddings and files
- Small ops page: ingestion errors by category, cost per day, p95 latency, latest eval score

**Platform**
- RLS matrix (owner, editor, viewer, stranger, anon) with real JWTs, catalog checks for bypasses
- OpenTofu stacks: bootstrap (encrypted state, OIDC), AWS (organization with guardrails, cost budget alarm), Cloudflare (DNS). GitHub rulesets and environments are created by hand and documented
- Plan in the PR, apply in CI with approval, plan guard against destroys, nightly drift check
- Environments: preview (per PR, no AWS access), develop (`main`, the second Vercel project `nblm-web-develop`), production (release tag with approval, Vercel project `nblm-web`); ADR 0009
- Release: migrations first, staged production deploy, smoke test and canary question against the exact artifact, promote, automatic rollback
- Eval harness: facts, abstention and prompt-injection cases; security cases are a hard gate
- CI: secret scan, workflow audit (offline and online), dependency review, IaC scan (trivy), CodeQL (JS/TS, Actions). Image scan: not applicable, nothing ships as a container image. Codex review: run by hand by the host session per PR
- Runbooks, ADRs, a game day with a real postmortem (after the v1.0.3 release)
- Ops page and Sentry error tracking (EU), account deletion

## v1.1

- GitHub rulesets and environments as code (infra/github)
- Codex review as a CI job
- RLS repro kit (a script that reproduces a reported isolation bug with real tokens)

- Hardened EC2 worker (no inbound ports, SSM instead of SSH, IMDSv2, Ansible hardening checked in CI)
- Audio overview on the worker: two voices discuss the sources
- Worker rollback by image digest; database restore drill with measured time

## Deliberately not built

| Not built | Why |
|---|---|
| Kubernetes, ECS, microservices | One app and one worker do not need an orchestrator. ECS is the next step if workers multiply. |
| Separate AWS accounts for dev and prod | One workload account, separated by IAM roles per environment. The split is an ADR, ready when there is a second operator. |
| A second LLM vendor | Fallback stays inside Bedrock EU, so no data leaves the EU on failover. A second vendor is a config change behind the provider interface. |
| Supabase branching per PR | Cost. The real gate is a full stack in the CI runner; previews are for looking at. |
| Hybrid (keyword + vector) search | Only if the eval shows vector search misses German terms. |
| Notes, studio features, video sources | Not needed to prove the platform. |
| Secrets Manager | GitHub environment secrets plus a secrets inventory and recovery runbook cover one operator. |
