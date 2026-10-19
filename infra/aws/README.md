# infra/aws

Workload account resources for the app. Planned in the PR and applied after merge by `.github/workflows/infra.yml`, never locally ([ADR 0009](../../docs/adr/0009-infra-pipeline-and-develop-project.md)). Steps, checks and rollback: [runbook](../../docs/runbooks/infra-apply.md).

| File | Contents |
|---|---|
| `versions.tf` | OpenTofu and provider pins; S3 backend (`aws/terraform.tfstate`, lockfile) and enforced state and plan encryption with the state key ([ADR 0003](../../docs/adr/0003-bootstrap-state-encryption.md)). No profile: CI gets credentials from the OIDC role of its job |
| `providers.tf` | Workload account only, locked with `allowed_account_ids`, eu-central-1 |
| `vercel.tf` | Vercel OIDC provider (team issuer `pascalnehlsens-projects`) and one role per deployment: `nblm-web-develop` (project `nblm-web-develop`) and `nblm-web-production` (project `nblm-web`), each trusted only from its project's `production` environment |
| `outputs.tf` | Role ARNs for `AWS_ROLE_ARN` in each Vercel project |
| `policies/` | Policy documents as JSON templates |

Native tests with mock providers: `tests/infra/aws/`. Static checks: `tests/unit/infra/aws-stack.test.ts`.

Known gaps:

- Bedrock access: embeddings with Titan Text Embeddings V2 (direct, eu-central-1), and chat with Amazon Nova 2 Lite only through the EU system inference profile `eu.amazon.nova-2-lite-v1:0` (invoke and stream; the foundation-model ARNs in its six EU regions are allowed only with the `bedrock:InferenceProfileArn` condition). Adding the chat policy plans as 2 to add, 0 to change, 0 to destroy.
- No AWS Budgets alarm yet; the app's per-user budget and kill switch (ADR 0006) are the cost control.
- The plan role (SecurityAudit) may lack reads for some resource types; expect AccessDenied when a new type is added and add targeted reads in a bootstrap PR.
- The plan guard blocks every delete and replace without an override.

Checks without AWS access:

```bash
scripts/tofu.sh fmt -check -recursive infra tests/infra
scripts/tofu.sh -chdir=infra/aws init -backend=false -lockfile=readonly -test-directory=../../tests/infra/aws
scripts/tofu.sh -chdir=infra/aws validate
scripts/tofu.sh -chdir=infra/aws test -test-directory=../../tests/infra/aws   # mock providers, no AWS calls
node --test 'tests/ci/*.test.mjs'
pnpm test
```
