# infra/bootstrap

What every other stack needs before CI can plan and apply it: the region SCP, the encrypted state bucket and its KMS key, the GitHub OIDC provider and the plan and apply roles. Applied once per change by the human from the host, never from CI or the sandbox ([ADR 0002](../../docs/adr/0002-bootstrap-applied-locally.md)). Steps and checks: [runbook](../../docs/runbooks/bootstrap.md).

| File | Contents |
|---|---|
| `versions.tf` | OpenTofu and provider pins; S3 backend (`bootstrap/terraform.tfstate`, lockfile) and OpenTofu state and plan encryption with the `aws_kms` key provider ([ADR 0003](../../docs/adr/0003-bootstrap-state-encryption.md)); the key ARN is `local.state_key_arn` |
| `providers.tf` | Workload account (default) and management account (`aws.management`), each locked with `allowed_account_ids` |
| `scp.tf` | `nblm-region-guard` (p-82q6pnrv) and the wizard policy p-ivy9gxl6 (imported unchanged), both attached to Root |
| `state.tf` | State bucket `nblm-tofu-state-278311879197` (versioned, private, SSE-KMS, TLS only, old versions kept 90 days) and KMS key `alias/nblm-tofu-state` (rotation, 30-day deletion window) |
| `oidc.tf` | GitHub OIDC provider; `nblm-tofu-plan` (environment `plan`: SecurityAudit plus state read and data key generation, writes denied) and `nblm-tofu-apply` (environment `infra`: AdministratorAccess plus a guard deny on the state bucket, key, CI roles and OIDC provider) |
| `outputs.tf` | Bucket, key and role ARNs for the other stacks and workflows |
| `policies/` | Policy documents as plain JSON, checked by `tests/unit/infra/` |

Native tests with mock providers: `tests/infra/bootstrap/`.

## Region guard

| Region | Allowed |
|---|---|
| eu-central-1 | everything |
| us-east-1 | global services only (IAM, STS, sign-in, Organizations, billing, Route 53, CloudFront, ACM and the rest of the wizard's list) |
| eu-north-1, eu-south-1, eu-south-2, eu-west-1, eu-west-3 | Bedrock inference only (targets of the `eu.*` cross-region inference profiles) |
| `unspecified` (requests without a region) | everything except Bedrock, as in the wizard policy; this blocks the `global.*` inference profiles |
| everything else | nothing |

IAM Identity Center needs no exemption: its home region is eu-central-1, in the management account, where SCPs do not apply.

Known gaps:

- The us-east-1 list is the wizard's and allows more than identity and billing, for example `q:*`, `cloudshell:*`, `logs:*` and `kms:*`. Trimming it is a later change.
- When the Bedrock model is chosen, check that its `eu.*` inference profile routes only to the five EU regions above plus eu-central-1 (`aws bedrock get-inference-profile`).
- Account 996270854231 is delegated administrator for `account-access.amazonaws.com`, which likely gives it a path to AccountFullAccessRole in the workload account. The aws stack imports `aws_organizations_delegated_administrator` and then removes it (deregisters the delegation); after that, decide whether AccountFullAccessRole is still needed. No manual change.
- The plan role can decrypt and read all state. It trusts only the `plan` environment, so every use needs the human's approval of that job run; the approver must check what the PR changes before approving (workflows, `scripts/`, data sources in `.tf`). State encryption protects state at rest, not from an approved run.
- SecurityAudit reads some configuration that can hold secrets (for example Lambda environment variables, EC2 user data). Keep secrets out of resource configuration. It also lacks some Get calls a plan needs (for example parts of Bedrock); expect AccessDenied in the first aws stack plans and add targeted reads then.
- State and plan encryption is enforced (`enforced = true`, no `unencrypted` method). Losing the state key loses all state in the bucket, since SSE-KMS uses it for every stack; for bootstrap there is no plaintext backup after runbook step 5. `prevent_destroy`, the 30-day deletion window and the apply guard protect the key; the state holds only ids and ARNs, so it could be rebuilt with imports.
- The plan role has `kms:GenerateDataKey` on the state key: the `aws_kms` key provider calls it on every run, also for reads (ADR 0003). It cannot write state, so CI plans run with `-lock=false`.
- The `infra` environment (required reviewer, `main` only) and the `plan` environment (required reviewer, no branch restriction) are created by hand; the github stack imports them.
- Nothing notices yet if the account wizard reattaches p-grnvof89 to Root. The nightly drift check (later PR) covers the Root SCP list.

Checks without AWS access:

```bash
scripts/tofu.sh fmt -check -recursive infra tests/infra
scripts/tofu.sh -chdir=infra/bootstrap init -backend=false -lockfile=readonly -test-directory=../../tests/infra/bootstrap
scripts/tofu.sh -chdir=infra/bootstrap validate
scripts/tofu.sh -chdir=infra/bootstrap test -test-directory=../../tests/infra/bootstrap   # mock providers, no AWS calls
pnpm test
```
