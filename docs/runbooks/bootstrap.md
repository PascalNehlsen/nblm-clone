# Runbook: apply infra/bootstrap

- Last rehearsed: never (first run is the real one)
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

Identity Center's home region is `sso_region` of the `nblm` sso-session in `~/.aws/config`. In the Identity Center console (Settings, Management), check the encryption: if it uses a customer managed KMS key, stop. Its home region then needs `kms:Decrypt` and `kms:DescribeKey` outside eu-central-1, which the new SCP denies.

Expected plan: 3 to import (p-ivy9gxl6, its Root attachment, the Root attachment of p-grnvof89), 2 to add (`nblm-region-guard` and its Root attachment), 0 to change, 0 to destroy.

Both SCPs are now attached, so the allowed set is their intersection. Check after a minute:

```bash
aws sts get-caller-identity --profile nblm-workload                                  # works
aws iam list-roles --max-items 1 --profile nblm-workload                             # works
aws ec2 describe-availability-zones --region eu-north-1 --profile nblm-workload      # now AccessDenied (explicit deny in an SCP)
aws bedrock list-foundation-models --region us-east-1 --profile nblm-workload        # now AccessDenied
aws organizations list-policies-for-target --target-id r-tmxq \
  --filter SERVICE_CONTROL_POLICY --profile nblm-mgmt-ro                              # FullAWSAccess, p-grnvof89, p-ivy9gxl6, nblm-region-guard
```

Then sign in to the console through the SSO portal into the workload account, and open IAM Identity Center in the Identity Delegated Admin account (996270854231) in its home region. Both must work.

S3 and KMS in eu-central-1 are still denied by p-grnvof89 at this point; that is expected.

## Rollback

The management account is not affected by SCPs, so it can always undo an SCP change. Emergency detach of the new policy, then reconcile in a PR:

```bash
aws organizations detach-policy --policy-id <nblm-region-guard id> --target-id r-tmxq --profile nblm-mgmt-admin
```
