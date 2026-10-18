# Runbook: apply infra/bootstrap

- Last rehearsed: never; steps 1 to 3 applied for real on 2026-10-17
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

Until step 4, state is local (`infra/bootstrap/terraform.tfstate`, git-ignored). Do not delete it. From step 4 on, state is in the bucket under `bootstrap/terraform.tfstate`, encrypted by OpenTofu ([ADR 0003](../adr/0003-bootstrap-state-encryption.md)), and plan files are encrypted too.

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

## Step 3: state bucket, KMS key, OIDC provider, plan and apply roles (PR `infra/bootstrap-state`)

Step 2 applied 2026-10-17: p-grnvof89 detached; S3 and KMS in eu-central-1 work.

Before the plan, check that the real gate for the apply role exists. GitHub creates a missing environment without protection the first time a workflow names it.

```bash
gh api repos/PascalNehlsen/nblm-clone/actions/oidc/customization/sub
# use_immutable_subject: true, sub_claim_prefix "repo:PascalNehlsen@164803589/nblm-clone@1421836505"
gh api repos/PascalNehlsen/nblm-clone/environments/infra \
  --jq '{r: [.protection_rules[] | {type, reviewers: [.reviewers[]?.reviewer.login]}], b: .deployment_branch_policy}'
# required_reviewers with PascalNehlsen, custom_branch_policies: true
gh api repos/PascalNehlsen/nblm-clone/environments/infra/deployment-branch-policies --jq '[.branch_policies[].name]'
# ["main"]
gh api repos/PascalNehlsen/nblm-clone/environments/plan \
  --jq '{r: [.protection_rules[] | {type, reviewers: [.reviewers[]?.reviewer.login]}], b: .deployment_branch_policy}'
# required_reviewers with PascalNehlsen; no branch restriction (b: null)
```

Checked 2026-10-17 from the sandbox (read-only): OIDC subject and `infra` as expected; `plan` did not exist yet (404). Do not apply until it exists with a required reviewer. Both environments are created by hand; the github stack imports them later.

Expected plan: `Plan: 16 to add, 0 to change, 0 to destroy.` All in the workload account: KMS key and alias; bucket `nblm-tofu-state-278311879197` with versioning, public access block, ownership controls, encryption, lifecycle and bucket policy; GitHub OIDC provider; `nblm-tofu-plan` with SecurityAudit and the state-read policy; `nblm-tofu-apply` with AdministratorAccess and the guard policy. State stays local in this step.

Check after the apply (bash or zsh):

```bash
export AWS_PROFILE=nblm-workload AWS_REGION=eu-central-1
B=nblm-tofu-state-278311879197
K=$(scripts/tofu.sh -chdir=infra/bootstrap output -raw state_key_arn)
scripts/tofu.sh -chdir=infra/bootstrap plan        # No changes. Your infrastructure matches the configuration.
aws s3api get-bucket-versioning --bucket "$B"                                    # Status: Enabled
aws s3api get-public-access-block --bucket "$B"                                  # all four true
aws s3api get-bucket-ownership-controls --bucket "$B"                            # BucketOwnerEnforced
aws s3api get-bucket-encryption --bucket "$B"                                    # aws:kms, KMSMasterKeyID = $K, BucketKeyEnabled: true
aws s3api get-bucket-policy --bucket "$B" --query Policy --output text           # only DenyInsecureTransport
aws kms get-key-rotation-status --key-id "$K"                                    # KeyRotationEnabled: true (aliases are not accepted here)
aws iam get-role --role-name nblm-tofu-plan --query Role.AssumeRolePolicyDocument    # sub ...:environment:plan, StringEquals only
aws iam get-role --role-name nblm-tofu-apply --query Role.AssumeRolePolicyDocument   # sub ...:environment:infra
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::278311879197:role/nblm-tofu-plan \
  --action-names s3:GetObject s3:PutObject s3:DeleteObject \
  --resource-arns "arn:aws:s3:::$B/bootstrap/terraform.tfstate" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]'                   # GetObject allowed, PutObject and DeleteObject explicitDeny
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::278311879197:role/nblm-tofu-apply \
  --action-names s3:PutObject s3:DeleteObject \
  --resource-arns "arn:aws:s3:::$B/bootstrap/terraform.tfstate" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]'                   # both explicitDeny: CI never writes bootstrap state
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::278311879197:role/nblm-tofu-apply \
  --action-names kms:ScheduleKeyDeletion --resource-arns "$K" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]'                   # explicitDeny
```

The roles are not used by any workflow yet; the plan-in-PR workflow comes later. Do not delete the local state.

## Step 4: move bootstrap state into the bucket, encrypted (PR `infra/bootstrap-migrate-state`)

Step 3 applied 2026-10-17. Run everything in the checkout that holds the local state. This step replaces "Every step" above: the migration comes before the plan.

```bash
aws sso login --sso-session nblm
export AWS_PROFILE=nblm-workload AWS_REGION=eu-central-1
B=nblm-tofu-state-278311879197
K=arn:aws:kms:eu-central-1:278311879197:key/88593446-cbdc-4378-a1b3-6b7a92c427f1
BK="$HOME/nblm-bootstrap-state-backup"     # outside every repository
```

1. Back up, still on the step 3 commit (before `git pull`):

```bash
scripts/tofu.sh -chdir=infra/bootstrap plan                         # No changes.
[ "$(scripts/tofu.sh -chdir=infra/bootstrap output -raw state_key_arn)" = "$K" ] && echo ok   # ok: local.state_key_arn in the PR is the real key
mkdir -m 700 "$BK"
cp -p infra/bootstrap/terraform.tfstate* "$BK"/ && chmod 600 "$BK"/*
(cd "$BK" && sha256sum terraform.tfstate* > SHA256SUMS && cat SHA256SUMS)
scripts/tofu.sh -chdir=infra/bootstrap state list > "$BK/state-list.txt"
aws s3api list-object-versions --bucket "$B" --prefix bootstrap/ \
  --query '[Versions,DeleteMarkers]'                                # [null, null]
```

2. Migrate. Answer `yes` to copying the existing state. The warning "Unencrypted method configured" is expected until PR 5.

```bash
git switch main && git pull --ff-only
scripts/tofu.sh -chdir=infra/bootstrap init -migrate-state -lockfile=readonly
```

3. Check the object before anything else:

```bash
aws s3api head-object --bucket "$B" --key bootstrap/terraform.tfstate \
  --query '[ServerSideEncryption,SSEKMSKeyId]'                      # ["aws:kms", "$K"]
aws s3 cp "s3://$B/bootstrap/terraform.tfstate" - | jq -c keys      # ["encrypted_data","encryption_version","meta"]
aws s3 cp "s3://$B/bootstrap/terraform.tfstate" - | jq -c '.meta | keys'   # ["key_provider.aws_kms.state"]
diff <(scripts/tofu.sh -chdir=infra/bootstrap state list) "$BK/state-list.txt"   # no output
```

If `keys` shows `resources`, `version` and so on, the migration wrote plaintext: the encryption config does not work as expected, and an apply would write plaintext too. Stop and use the rollback before the apply. Anything else wrong: same.

4. Plan and apply:

```bash
scripts/tofu.sh -chdir=infra/bootstrap plan -out=bootstrap.tfplan
head -c 60 infra/bootstrap/bootstrap.tfplan; echo                   # {"meta":{"key_provider.aws_kms.state":... (encrypted), not "PK" (a plain zip)
```

Expected plan: `Plan: 0 to add, 1 to change, 0 to destroy.` The one change is `aws_iam_role_policy.tofu_plan_state_read`, which gains the statement `GenerateDataKeyForStateEncryption`. Paste the summary into the PR, then apply and `rm infra/bootstrap/bootstrap.tfplan`.

5. Verify:

```bash
scripts/tofu.sh -chdir=infra/bootstrap plan                         # No changes.
aws s3api head-object --bucket "$B" --key bootstrap/terraform.tfstate.tflock   # 404 Not Found: no lock left behind
for v in $(aws s3api list-object-versions --bucket "$B" --prefix bootstrap/terraform.tfstate \
    --query "Versions[?Key=='bootstrap/terraform.tfstate'].VersionId" --output text); do
  aws s3api get-object --bucket "$B" --key bootstrap/terraform.tfstate --version-id "$v" "$BK/v.json" > /dev/null
  echo "$v $(jq -c keys "$BK/v.json")"                              # every version: ["encrypted_data","encryption_version","meta"]
done; rm -f "$BK/v.json"
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::278311879197:role/nblm-tofu-plan \
  --action-names kms:GenerateDataKey kms:Decrypt --resource-arns "$K" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]'       # both allowed
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::278311879197:role/nblm-tofu-plan \
  --action-names s3:PutObject --resource-arns "arn:aws:s3:::$B/bootstrap/terraform.tfstate.tflock" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]'       # explicitDeny: CI plans run with -lock=false
```

6. Only after step 5 passed, remove the local state and prove the bucket is the source:

```bash
rm -f infra/bootstrap/terraform.tfstate infra/bootstrap/terraform.tfstate.backup
scripts/tofu.sh -chdir=infra/bootstrap plan                         # No changes.
```

Keep `$BK` (plaintext state) until PR 5 is applied and its plan shows no changes; then `rm -rf "$BK"`.

## Rollback

The management account is not affected by SCPs, so it can always undo an SCP change. Never leave Root without a region SCP: attach before you detach.

```bash
# Undo step 2: reattach the old policy (back to the intersection verified in step 1).
# Works only until a later PR deletes p-grnvof89; after that, recreate it from the saved content.
aws organizations attach-policy --policy-id p-grnvof89 --target-id r-tmxq --profile nblm-mgmt-admin

# Undo step 1, only if nblm-region-guard itself is the problem, and only after p-grnvof89 is attached again:
aws organizations detach-policy --policy-id p-82q6pnrv --target-id r-tmxq --profile nblm-mgmt-admin
```

Undo step 3: leave the new resources in place. No workflow uses the roles yet, the bucket is empty, and the key costs about 1 USD a month. Removing them by hand is drift, and `prevent_destroy` blocks a tofu destroy of the bucket, key and OIDC provider on purpose; a fix goes through a PR and a new apply.

Undo step 4, before the apply (migration failed or the object is wrong). Same variables as step 4; the admin profile can delete versions, the apply role cannot:

```bash
for kind in Versions DeleteMarkers; do
  aws s3api list-object-versions --bucket "$B" --prefix bootstrap/ \
    --query "$kind[].[Key,VersionId]" --output text |
    while read -r key id; do
      [ "$key" = None ] || aws s3api delete-object --bucket "$B" --key "$key" --version-id "$id"
    done
done
aws s3api list-object-versions --bucket "$B" --prefix bootstrap/ --query '[Versions,DeleteMarkers]'   # [null, null]
git switch --detach 6abdfed                                          # step 3 commit, no backend
cp -p "$BK"/terraform.tfstate* infra/bootstrap/
(cd infra/bootstrap && sha256sum -c "$BK/SHA256SUMS")                # OK for each file
scripts/tofu.sh -chdir=infra/bootstrap init -reconfigure -lockfile=readonly
scripts/tofu.sh -chdir=infra/bootstrap plan                          # No changes.
```

Then revert the PR, or fix it and start step 4 again.

Undo step 4, after the apply: the bucket is the source of truth and the backup lacks the policy change. Fix forward in a PR. Only if the key is unusable: restore the backup as above; the next plan shows the plan role policy change again.

A manual attach or detach is drift that tofu does not know about. Reconcile it in a PR: a reattached p-grnvof89 needs an `import {}` block for its attachment again, and a detached p-82q6pnrv shows up in the next plan as `region_guard_root` to create, which is the way to reattach it once fixed.
