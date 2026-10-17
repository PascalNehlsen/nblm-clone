# Runbook: apply infra/bootstrap

- Last rehearsed: never; step 1 applied for real on 2026-10-17
- Who: the human, from the host, never from the sandbox or CI ([ADR 0002](../adr/0002-bootstrap-applied-locally.md))
- Profiles (sso-session `nblm`): `nblm-workload` (workload admin), `nblm-mgmt-admin` (management admin), `nblm-mgmt-ro` (management read-only, for checks)

## Every step

```bash
aws sso login --sso-session nblm
git switch main && git pull --ff-only     # apply only what was merged
scripts/tofu.sh -chdir=infra/bootstrap init -lockfile=readonly
scripts/tofu.sh -chdir=infra/bootstrap plan -out=bootstrap.tfplan
```

Compare the plan with the step below. Anything else in it: stop, do not apply. Paste the plan summary into the PR, then:

```bash
scripts/tofu.sh -chdir=infra/bootstrap apply bootstrap.tfplan
rm infra/bootstrap/bootstrap.tfplan
```

Until the state migration step, state is local (`infra/bootstrap/terraform.tfstate`, git-ignored). Do not delete it.

## Step 1: attach the new region SCP next to the old one (PR `infra/bootstrap-scp`)

Before the plan:

```bash
aws organizations list-tags-for-resource --resource-id p-ivy9gxl6 --profile nblm-mgmt-ro   # expect no tags
```

Expected plan: 3 to import (p-ivy9gxl6, its Root attachment, the Root attachment of p-grnvof89), 2 to add (`nblm-region-guard` and its Root attachment), 0 to change, 0 to destroy.

Both SCPs are now attached, so the allowed set is their intersection. Check after a minute:

```bash
aws sts get-caller-identity --profile nblm-workload                                  # works
aws iam list-roles --max-items 1 --profile nblm-workload                             # works
aws kms list-keys --region eu-north-1 --profile nblm-workload                        # now denied: "explicit deny in a service control policy"
aws bedrock list-foundation-models --region us-east-1 --profile nblm-workload        # now denied: "explicit deny in a service control policy"
aws organizations list-policies-for-target --target-id r-tmxq \
  --filter SERVICE_CONTROL_POLICY --profile nblm-mgmt-ro                              # FullAWSAccess, p-grnvof89, p-ivy9gxl6, nblm-region-guard
```

Then sign in to the console through the SSO portal into the workload account; it must work. (IAM Identity Center itself runs in eu-central-1 in the management account, checked 2026-10-17: AWS owned key, no SCPs apply.)

S3 and KMS in eu-central-1 are still denied by p-grnvof89 at this point; that is expected.

## Step 2: detach the old region SCP (PR `infra/bootstrap-detach`)

Step 1 applied 2026-10-17: `nblm-region-guard` is p-82q6pnrv.

Before the plan, `scripts/tofu.sh -chdir=infra/bootstrap state show aws_organizations_policy_attachment.legacy_region_restriction_root` must not show `skip_destroy = true` (otherwise the destroy would only drop it from state and leave the policy attached).

Expected plan: `Plan: 0 to add, 0 to change, 1 to destroy.` The one destroy is `aws_organizations_policy_attachment.legacy_region_restriction_root`: it detaches p-grnvof89 from r-tmxq. The policy itself stays until a later PR deletes it.

Check after a minute:

```bash
aws organizations list-policies-for-target --target-id r-tmxq \
  --filter SERVICE_CONTROL_POLICY --profile nblm-mgmt-ro                              # FullAWSAccess, p-ivy9gxl6, nblm-region-guard; no p-grnvof89
aws s3api list-buckets --region eu-central-1 --profile nblm-workload                 # now works
aws kms list-keys --region eu-central-1 --profile nblm-workload                      # now works
aws kms list-keys --region eu-north-1 --profile nblm-workload                        # still denied: "explicit deny in a service control policy" (p-82q6pnrv)
aws bedrock list-foundation-models --region us-east-1 --profile nblm-workload        # still denied: "explicit deny in a service control policy" (p-82q6pnrv)
aws ec2 describe-availability-zones --region us-east-1 --profile nblm-workload       # still denied (UnauthorizedOperation): us-east-1 stays global services only
aws bedrock list-foundation-models --region eu-north-1 --profile nblm-workload       # works (was already allowed before, not evidence of the detach)
```

Then sign in to the console through the SSO portal into the workload account; it must work.

## Rollback

The management account is not affected by SCPs, so it can always undo an SCP change. Never leave Root without a region SCP: attach before you detach.

```bash
# Undo step 2: reattach the old policy (back to the intersection verified in step 1).
# Works only until a later PR deletes p-grnvof89; after that, recreate it from the saved content.
aws organizations attach-policy --policy-id p-grnvof89 --target-id r-tmxq --profile nblm-mgmt-admin

# Undo step 1, only if nblm-region-guard itself is the problem, and only after p-grnvof89 is attached again:
aws organizations detach-policy --policy-id p-82q6pnrv --target-id r-tmxq --profile nblm-mgmt-admin
```

A manual attach or detach is drift that tofu does not know about. Reconcile it in a PR: a reattached p-grnvof89 needs an `import {}` block for its attachment again, and a detached p-82q6pnrv shows up in the next plan as `region_guard_root` to create, which is the way to reattach it once fixed.
