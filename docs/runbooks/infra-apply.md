# Runbook: plan and apply infra/aws

- Last rehearsed: never; the first apply is the merge of the PR that adds `infra/aws`
- Who: CI only (`.github/workflows/infra.yml`); the human approves the `plan` and `infra` environment runs. Never applied locally ([ADR 0009](../adr/0009-infra-pipeline-and-develop-project.md))
- Roles: `nblm-tofu-plan` (environment `plan`), `nblm-tofu-apply` (environment `infra`, `main` only), both from `infra/bootstrap`

## Every change

1. Open the PR. The `plan` job waits for the `plan` environment. Before approving it, read what the PR changes in `.github/workflows/`, `scripts/` and data sources in `infra/aws/*.tf`: the job runs that code with read access to all state.
2. Approve. The job runs `tofu plan -lock=false`, then the plan guard. Read the run summary: the guard's table lists every resource change, and the plan output is below it. A delete, replace or forget fails the job.
3. Paste the summary line (`Plan: X to add, Y to change, 0 to destroy.`) into the PR.
4. Merge. On `main`, `plan (main)` waits for `plan` again: approve. It saves the plan (encrypted, ADR 0003), checks that the file is not a plain zip, runs the guard and uploads the file for one day. If the plan has no changes, the run ends there.
5. `apply` waits for `infra`. Before approving, compare the `plan (main)` summary with the PR summary from step 3. Anything else in it: reject, find out why (drift, a second merge).
6. Approve. The job downloads exactly that plan file, runs the guard on it again and applies it. A saved plan fails if state changed after it was made: rerun the whole workflow, never only the apply job with a fresh plan you did not read.

Only one run of the workflow on `main` runs at a time and none is cancelled. A newer push waits; if a third arrives meanwhile, GitHub drops the waiting middle run, which is fine because the newest run plans everything merged so far.

## Checks after the first apply (host, read-only)

```bash
aws sso login --sso-session nblm
export AWS_PROFILE=nblm-workload AWS_REGION=eu-central-1
aws iam list-open-id-connect-providers                                     # includes oidc.vercel.com/pascalnehlsens-projects
aws iam get-role --role-name nblm-web-develop --query Role.AssumeRolePolicyDocument      # StringEquals only, sub ...project:nblm-web-develop:environment:production
aws iam get-role --role-name nblm-web-production --query Role.AssumeRolePolicyDocument   # StringEquals only, sub ...project:nblm-web:environment:production
aws iam get-role-policy --role-name nblm-web-develop --policy-name bedrock-embeddings     # bedrock:InvokeModel on the Titan V2 ARN only
aws s3api head-object --bucket nblm-tofu-state-278311879197 --key aws/terraform.tfstate.tflock   # 404: no lock left behind
```

## Vercel environment variables per project

Set in the Vercel dashboard for the `Production` environment of each project only, never for Preview or Development. None of them is a secret except `SUPABASE_SECRET_KEY` (mark it sensitive).

| Variable | `nblm-web-develop` (develop) | `nblm-web` (production) |
|---|---|---|
| `AWS_ROLE_ARN` | output `develop_role_arn` | output `production_role_arn` |
| `BEDROCK_REGION` | `eu-central-1` | `eu-central-1` |
| `BEDROCK_EMBEDDING_MODEL_ID` | `amazon.titan-embed-text-v2:0` | `amazon.titan-embed-text-v2:0` |
| `SUPABASE_SECRET_KEY` | develop Supabase project, only once a route calls the model | production Supabase project |

The Supabase and site variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`) for develop are in [develop-deploy.md](develop-deploy.md).

The role ARNs are in the `apply` job log (`Outputs:`). OIDC federation must be on in each project (Settings, Security, Secure backend access with OIDC federation, team issuer mode). On the first real call, check the subject: decode the OIDC claims and look at `sub` and `aud` only; never log or paste the full value. A wrong subject fails with `AccessDenied` on `AssumeRoleWithWebIdentity`, which is the safe direction.

## Rollback

- **Bad change, apply not approved yet:** reject the `infra` approval. Nothing changed. Revert or fix the PR.
- **Bad change, applied:** fix forward with a revert PR; it goes through the same plan, guard and approval. If the revert needs a delete (for example, the bad change created a resource), the guard blocks it: that needs a PR that changes the guard for that one case, reviewed by the human.
- **Apply failed halfway:** the state has what was created. Rerun the workflow on `main`; the new plan shows only what is left. Do not edit state by hand.
- **Lock left behind** (`aws/terraform.tfstate.tflock` exists, no run active): the human removes it from the host with the admin profile, after checking in the Actions tab that no apply runs: `aws s3 rm s3://nblm-tofu-state-278311879197/aws/terraform.tfstate.tflock`.
- **Stop Bedrock access now:** remove `AWS_ROLE_ARN` from the Vercel project and redeploy, or turn the model kill switch on (`docs/runbooks/kill-switch.md`). Then fix the role through a PR.

## After a rehearsal

Update "Last rehearsed" above with the date and what was applied.
