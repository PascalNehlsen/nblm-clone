# 0024: A nightly drift check with the plan role, in a reviewer-free `drift` environment

- Status: accepted (Pascal, 2026-10-20)
- Date: 2026-10-20

## Context

Infra changes go through `tofu plan` in the PR and `apply` in CI (ADR 0009), but nothing noticed a change made outside OpenTofu, for example in the AWS console or Cloudflare dashboard. The plan role is the only role that can read state, and it trusted only the `plan` environment, which has a required reviewer. A scheduled job would wait for an approval every night.

## Decision

- **Schedule:** `.github/workflows/drift.yml` runs every night and on demand. It runs `tofu plan -lock=false -detailed-exitcode` for `infra/aws` and `infra/cloudflare` with the plan role.
- **Outcome:** a difference fails the run, with the plan in the summary, and GitHub emails Pascal. Nothing is applied, saved or uploaded, and no issue is opened.
- **Environment:** the job uses a new `drift` environment with no reviewer and deployment branches limited to `main`. The plan role's trust policy accepts exactly two subjects: `environment:plan` and `environment:drift` (StringEquals, no wildcard).
- **Setup by Pascal, in this order:**
  1. Create the environment with deployment branches set to **`main` only**. This setting is the control: GitHub creates a missing environment on first reference, unprotected, so it must exist with the branch rule before the trust change is applied.
  2. Check it with `gh api repos/PascalNehlsen/nblm-clone/environments/drift`, which should show a `deployment_branch_policy`.
  3. Add a read-only Cloudflare token and `BUDGET_ALERT_EMAIL`.
  4. Apply the trust change locally (ADR 0002).
- **Budgets:** the plan role also gets `budgets:ViewBudget` and `budgets:ListTagsForResource` on the workload account's budgets. Without them, refreshing the budget from #63 would fail, both in this check and in every later `infra/aws` plan.

## Consequences

- Drift shows up within a day.
- The plan role, which decrypts all state, can now be used without a per-run approval, but only by workflow code on `main`. That code passed review and the required checks. A PR cannot use `drift`, because the environment allows only `main`.
- The branch rule on `drift` is a manual GitHub setting that nothing checks, until the GitHub stack (v1.1) manages it.
- Management-account SCPs are out of reach for the workload-account plan role. Those stay a manual check (bootstrap runbook).
- Revisit with a separate drift role if the plan role ever needs more than read access.

## Alternatives considered

- **Manual dispatch with the `plan` approval:** no trust change, but nothing runs unless someone remembers.
- **Removing the reviewer from `plan`:** any branch could run its own code with full state read.
