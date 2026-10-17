# 0002: The bootstrap stack is applied once, locally, by the human

- Status: accepted
- Date: 2026-10-17

## Context

Every other stack is planned in the PR with a read-only role and applied in CI after the `infra` environment approval. Those roles, their OIDC provider, the state bucket and its KMS key cannot create themselves. The wizard's region SCP (p-grnvof89) also denies everything but Bedrock in eu-central-1, and SCPs are managed from the management account, where SCPs do not apply. Agents have no cloud credentials, so they cannot do this step.

## Decision

- `infra/bootstrap` is one stack with two providers, workload (`nblm-workload`) and management (`nblm-mgmt-admin`), each locked with `allowed_account_ids`. It owns the region SCP, the imported wizard policy p-ivy9gxl6 (unchanged), the state bucket, the KMS key, the GitHub OIDC provider and the plan and apply roles.
- The human applies it from the host, from a merged `main` commit, one apply per PR: new region SCP next to the old one; old one detached; bucket, key, OIDC and roles; state migrated into the bucket with an encryption fallback; fallback removed. Each plan goes into its PR. Steps: `docs/runbooks/bootstrap.md`.
- No other stack is ever applied locally. Imports are `import {}` blocks in reviewed code.
- What stops an agent from applying is the missing credentials in the sandbox. The deny rules for `tofu apply`, `import` and `state` in `.claude/settings.json` are a speed bump only; they do not match `scripts/tofu.sh apply`. Follow-up: matching rules for the script, in a separate `.claude/` PR.
- Protected resources (SCPs and their attachments, bucket, key, OIDC provider) have `prevent_destroy`.
- The apply role has AdministratorAccess. Its guard deny is a speed bump, since an admin can create another admin role. The real gate is the GitHub environment `infra` with a required reviewer, `main` only.
- AccountFullAccessRole (`/managed/`, AdministratorAccess, trusted by `account-access.amazonaws.com`) stays for now, protected by p-ivy9gxl6. Account 996270854231 is delegated administrator for `account-access.amazonaws.com`, which likely gives it a path to this role. The aws stack deregisters that delegation (import `aws_organizations_delegated_administrator`, then remove it); then we decide whether the role is still needed. No manual change.

## Consequences

CI never holds rights to change its own trust or state backend. The cost is an ordered manual procedure for one person, and unencrypted local state (ids and ARNs only) until the migration step. Every later bootstrap change, such as management-account roles for the aws stack or a drift-check role, is again a PR plus a local apply. Revisit with a second operator, or if bootstrap changes more than a few times a year.

## Alternatives considered

- **Apply bootstrap from CI with temporary admin keys**: long-lived keys in GitHub, what OIDC removes.
- **ClickOps for bootstrap**: no review, no record, drift from day one.
- **Edit p-grnvof89 in place**: no overlap to verify the new policy; the wizard may reassert it.
- **SCP and state in one apply**: no dependency across the two accounts and SCPs propagate with a delay, so the bucket would race the SCP.
