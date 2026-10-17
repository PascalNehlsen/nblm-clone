# infra/bootstrap

What every other stack needs before CI can plan and apply it: the region SCP, the encrypted state bucket and its KMS key, the GitHub OIDC provider and the plan and apply roles. Applied once per change by the human from the host, never from CI or the sandbox ([ADR 0002](../../docs/adr/0002-bootstrap-applied-locally.md)). Steps and checks: [runbook](../../docs/runbooks/bootstrap.md).

| File | Contents |
|---|---|
| `versions.tf` | OpenTofu and provider pins; no backend until the state bucket exists |
| `providers.tf` | Workload account (default) and management account (`aws.management`), each locked with `allowed_account_ids` |
| `scp.tf` | `nblm-region-guard`, the imported wizard policy p-ivy9gxl6, and the wizard region SCP attachment that is detached next |
| `imports.tf` | One-time `import {}` blocks; removed in the next step, after the import is applied |
| `policies/` | Policy documents as plain JSON, checked by `tests/unit/infra/` |

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

Checks without AWS access:

```bash
scripts/tofu.sh fmt -check -recursive infra
scripts/tofu.sh -chdir=infra/bootstrap init -backend=false -lockfile=readonly
scripts/tofu.sh -chdir=infra/bootstrap validate
pnpm test
```
