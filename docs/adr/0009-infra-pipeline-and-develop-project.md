# 0009: infra/aws is planned and applied in CI; develop is a second Vercel project

- Status: accepted
- Date: 2026-10-19

## Context

`infra/aws` is the first stack after bootstrap. Bootstrap created the plan role (environment `plan`, read-only) and the apply role (environment `infra`, admin) for CI; nothing used them yet (ADR 0002). The web app needs Bedrock for embeddings, reached from Vercel by OIDC, without AWS keys. The Vercel Hobby plan has no custom environments, so one project cannot keep develop and production apart: both would be the `production` environment of the same project and share one OIDC subject. Previews run code from any branch and must not get AWS access.

## Decision

- `.github/workflows/infra.yml` plans `infra/aws` on pull requests (environment `plan`, same-repo head only, `-lock=false`) and, after merge, plans again on `main`, uploads the saved plan and applies exactly that plan in a separate job (environment `infra`, `main` only). One concurrency group for `main`, never cancelled. Nobody applies `infra/aws` locally. Steps: `docs/runbooks/infra-apply.md`.
- `scripts/plan-guard.mjs` reads `tofu show -json` and fails on every action other than create, update, read and no-op: delete, replace and forget fail, and so does output it cannot parse. It runs on every plan and again before the apply. There is no override in v1: a destroy is a PR that changes the guard, reviewed as high risk.
- Plan files are encrypted with the state key (ADR 0003, enforced), so the uploaded artifact is ciphertext. In CI only the apply job writes `aws/terraform.tfstate` and its lock; the plan role cannot write state.
- develop is a second Vercel project, `nblm-web-develop`, whose `production` environment deploys `main`. Production is the `production` environment of `nblm-web`, deployed from a release tag. Each has its own IAM role, trusted by `StringEquals` on the exact `sub` (`owner:pascalnehlsens-projects:project:<project>:environment:production`) and `aud` (`https://vercel.com/pascalnehlsens-projects`) of the team issuer. No role trusts a `preview` or `development` subject, so previews of either project get no AWS access. A wrong subject fails closed.
- Both roles may call only `bedrock:InvokeModel` on `amazon.titan-embed-text-v2:0` in eu-central-1, no wildcards. Chat model permissions come with block D.

## Consequences

Every AWS change has a reviewed plan, a second human approval before the apply and a record in the Actions log. The cost: each PR plan and each apply waits for an environment approval, and a refactor that needs a replace or a `moved` with destroy must change the guard first. Two Vercel projects double the env var and domain setup; the runbook lists them. Revisit when the account moves to a Vercel plan with custom environments, or if a second operator joins.

## Alternatives considered

- **Apply on the host like bootstrap**: no record, no second look, and it needs the human's admin credentials for every change.
- **One Vercel project, develop as a preview branch**: previews share one subject per project, so develop could not get Bedrock access without every preview getting it too.
- **Plan and apply in one job**: the apply would run a plan nobody saw; the saved plan pins what was approved.
- **Plan guard with a label override**: a label is set by anyone with write access, agents included.
