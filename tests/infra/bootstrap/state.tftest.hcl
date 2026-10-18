# OpenTofu native test for infra/bootstrap, PR 3 (infra/bootstrap-state).
# Same style as scp.tftest.hcl: mock providers, `command = plan` only, never
# `apply`. aws_kms_key.state, aws_s3_bucket.state and
# aws_iam_openid_connect_provider.github all carry `lifecycle { prevent_destroy
# = true }`, so an apply'd run here would fail tofu test's post-run destroy
# (leaving an errored_test.tfstate behind, while the command itself still
# exits 0) for the same reason scp.tftest.hcl avoids apply for the SCP
# resources.
#
# Run from repo root with the pinned OpenTofu binary (never plain `tofu`):
#   scripts/tofu.sh -chdir=infra/bootstrap init -backend=false -test-directory=../../tests/infra/bootstrap
#   scripts/tofu.sh -chdir=infra/bootstrap test -test-directory=../../tests/infra/bootstrap

mock_provider "aws" {}

mock_provider "aws" {
  alias = "management"
}

run "state_bucket_sse_uses_the_state_key" {
  command = plan

  override_resource {
    target = aws_s3_bucket.state
    values = {
      id  = "nblm-tofu-state-278311879197"
      arn = "arn:aws:s3:::nblm-tofu-state-278311879197"
    }
  }

  override_resource {
    target = aws_kms_key.state
    values = {
      arn    = "arn:aws:kms:eu-central-1:278311879197:key/mock"
      key_id = "mock"
    }
  }

  # aws provider 6.67.0 types `rule` on this resource as a set, and
  # `apply_server_side_encryption_by_default` inside it as a set too, so
  # neither can be indexed with `[0]` ("Cannot index a set value"). `one()`
  # over a flattened for-expression works for both single-element sets.
  assert {
    condition = one(flatten([
      for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : [
        for d in r.apply_server_side_encryption_by_default : d.kms_master_key_id
      ]
    ])) == "arn:aws:kms:eu-central-1:278311879197:key/mock"
    error_message = "the bucket's SSE configuration must use aws_kms_key.state, not another key"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : r.bucket_key_enabled]) == true
    error_message = "the bucket's SSE configuration must enable bucket keys"
  }
}

run "kms_alias_targets_the_state_key" {
  command = plan

  override_resource {
    target = aws_kms_key.state
    values = {
      arn    = "arn:aws:kms:eu-central-1:278311879197:key/mock"
      key_id = "mock"
    }
  }

  assert {
    condition     = aws_kms_alias.state.target_key_id == "mock"
    error_message = "alias/nblm-tofu-state must target aws_kms_key.state"
  }
}

run "every_s3_bucket_sub_resource_targets_the_state_bucket" {
  command = plan

  override_resource {
    target = aws_s3_bucket.state
    values = {
      id  = "nblm-tofu-state-278311879197"
      arn = "arn:aws:s3:::nblm-tofu-state-278311879197"
    }
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.bucket == "nblm-tofu-state-278311879197"
    error_message = "aws_s3_bucket_versioning.state must target aws_s3_bucket.state"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.bucket == "nblm-tofu-state-278311879197"
    error_message = "aws_s3_bucket_public_access_block.state must target aws_s3_bucket.state"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.bucket == "nblm-tofu-state-278311879197"
    error_message = "aws_s3_bucket_ownership_controls.state must target aws_s3_bucket.state"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.state.bucket == "nblm-tofu-state-278311879197"
    error_message = "aws_s3_bucket_server_side_encryption_configuration.state must target aws_s3_bucket.state"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.state.bucket == "nblm-tofu-state-278311879197"
    error_message = "aws_s3_bucket_lifecycle_configuration.state must target aws_s3_bucket.state"
  }

  assert {
    condition     = aws_s3_bucket_policy.state.bucket == "nblm-tofu-state-278311879197"
    error_message = "aws_s3_bucket_policy.state must target aws_s3_bucket.state"
  }
}

# P1 fix from the Codex review: the plan role no longer trusts every
# pull_request run (anyone who can push a branch, the sandbox included, could
# otherwise run arbitrary code with it). It now trusts only the GitHub
# environment "plan", which has a required reviewer, like the apply role's
# "infra".
run "plan_role_trust_is_scoped_to_the_plan_environment_on_the_immutable_subject" {
  command = plan

  override_resource {
    target = aws_iam_openid_connect_provider.github
    values = {
      arn = "arn:aws:iam::278311879197:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  assert {
    condition     = jsondecode(aws_iam_role.tofu_plan.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::278311879197:oidc-provider/token.actions.githubusercontent.com"
    error_message = "tofu_plan must trust exactly the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.tofu_plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:PascalNehlsen@164803589/nblm-clone@1421836505:environment:plan"
    error_message = "tofu_plan must trust only the plan environment subject on the immutable repo id, not every pull_request run"
  }
}

run "apply_role_trust_is_scoped_to_the_infra_environment_on_the_immutable_subject" {
  command = plan

  override_resource {
    target = aws_iam_openid_connect_provider.github
    values = {
      arn = "arn:aws:iam::278311879197:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  assert {
    condition     = jsondecode(aws_iam_role.tofu_apply.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::278311879197:oidc-provider/token.actions.githubusercontent.com"
    error_message = "tofu_apply must trust exactly the GitHub OIDC provider"
  }

  assert {
    condition     = jsondecode(aws_iam_role.tofu_apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:PascalNehlsen@164803589/nblm-clone@1421836505:environment:infra"
    error_message = "tofu_apply must trust only the infra environment subject on the immutable repo id"
  }
}

run "plan_state_read_policy_covers_the_real_bucket_and_key" {
  command = plan

  override_resource {
    target = aws_s3_bucket.state
    values = {
      id  = "nblm-tofu-state-278311879197"
      arn = "arn:aws:s3:::nblm-tofu-state-278311879197"
    }
  }

  override_resource {
    target = aws_kms_key.state
    values = {
      arn    = "arn:aws:kms:eu-central-1:278311879197:key/mock"
      key_id = "mock"
    }
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_plan_state_read.policy).Statement : s.Resource]), "arn:aws:s3:::nblm-tofu-state-278311879197")
    error_message = "tofu_plan_state_read must reference the real state bucket arn, not a placeholder"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_plan_state_read.policy).Statement : s.Resource]), "arn:aws:kms:eu-central-1:278311879197:key/mock")
    error_message = "tofu_plan_state_read must reference the real key arn, not a placeholder"
  }

  # PR 4 / ADR 0003: OpenTofu 1.13.1's aws_kms key provider calls
  # kms:GenerateDataKey on every Provide(), including plan-only, read-only
  # runs, so the plan role needs it allowed on the real key arn.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.tofu_plan_state_read.policy).Statement :
      s.Effect == "Allow" &&
      contains(flatten([s.Action]), "kms:GenerateDataKey") &&
      contains(flatten([s.Resource]), "arn:aws:kms:eu-central-1:278311879197:key/mock")
    ])
    error_message = "tofu_plan_state_read must allow kms:GenerateDataKey on the real key arn, not a placeholder"
  }

  # Review follow-up: the anytrue assertion above only requires that *some*
  # Allow statement grants kms:GenerateDataKey on the real key arn. A second
  # Allow statement, under another Sid, granting kms:GenerateDataKey (or a
  # covering wildcard) on "*" would still pass it unnoticed. These two
  # assertions close that gap: every Allow statement that mentions
  # kms:GenerateDataKey must be scoped to the real key arn only, and there
  # must be exactly one such statement.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.tofu_plan_state_read.policy).Statement :
      flatten([s.Resource]) == ["arn:aws:kms:eu-central-1:278311879197:key/mock"]
      if s.Effect == "Allow" && contains(flatten([s.Action]), "kms:GenerateDataKey")
    ])
    error_message = "every Allow statement granting kms:GenerateDataKey must scope Resource to the real key arn only, not \"*\" or another resource"
  }

  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.tofu_plan_state_read.policy).Statement :
      s if s.Effect == "Allow" && contains(flatten([s.Action]), "kms:GenerateDataKey")
    ]) == 1
    error_message = "exactly one Allow statement may grant kms:GenerateDataKey"
  }
}

run "apply_guard_policy_covers_the_bucket_key_both_roles_oidc_and_alias" {
  command = plan

  override_resource {
    target = aws_s3_bucket.state
    values = {
      id  = "nblm-tofu-state-278311879197"
      arn = "arn:aws:s3:::nblm-tofu-state-278311879197"
    }
  }

  override_resource {
    target = aws_kms_key.state
    values = {
      arn    = "arn:aws:kms:eu-central-1:278311879197:key/mock"
      key_id = "mock"
    }
  }

  # aws_kms_alias.state.arn feeds the apply-guard's key_alias_arn variable
  # (review follow-up: deny kms:UpdateAlias/kms:DeleteAlias on the alias, not
  # just the key itself).
  override_resource {
    target = aws_kms_alias.state
    values = {
      arn = "arn:aws:kms:eu-central-1:278311879197:alias/nblm-tofu-state"
    }
  }

  override_resource {
    target = aws_iam_role.tofu_plan
    values = {
      arn = "arn:aws:iam::278311879197:role/nblm-tofu-plan"
    }
  }

  # apply_role_arn now comes straight from aws_iam_role.tofu_apply.arn (no
  # cycle), not from a hand-built string, so overriding it here is meaningful.
  override_resource {
    target = aws_iam_role.tofu_apply
    values = {
      arn = "arn:aws:iam::278311879197:role/nblm-tofu-apply"
    }
  }

  override_resource {
    target = aws_iam_openid_connect_provider.github
    values = {
      arn = "arn:aws:iam::278311879197:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_apply_guard.policy).Statement : s.Resource]), "arn:aws:kms:eu-central-1:278311879197:key/mock")
    error_message = "tofu_apply_guard must reference the real key arn"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_apply_guard.policy).Statement : s.Resource]), "arn:aws:s3:::nblm-tofu-state-278311879197")
    error_message = "tofu_apply_guard must reference the real bucket arn"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_apply_guard.policy).Statement : s.Resource]), "arn:aws:iam::278311879197:role/nblm-tofu-plan")
    error_message = "tofu_apply_guard must reference the real plan role arn"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_apply_guard.policy).Statement : s.Resource]), "arn:aws:iam::278311879197:role/nblm-tofu-apply")
    error_message = "tofu_apply_guard must reference the real apply role arn (aws_iam_role.tofu_apply.arn directly, no cycle)"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_apply_guard.policy).Statement : s.Resource]), "arn:aws:iam::278311879197:oidc-provider/token.actions.githubusercontent.com")
    error_message = "tofu_apply_guard must reference the real OIDC provider arn"
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.tofu_apply_guard.policy).Statement : s.Resource]), "arn:aws:kms:eu-central-1:278311879197:alias/nblm-tofu-state")
    error_message = "tofu_apply_guard must reference the real key alias arn"
  }
}

run "kms_key_policy_grants_only_the_account_root" {
  command = plan

  assert {
    condition     = jsondecode(aws_kms_key.state.policy).Statement[0].Principal.AWS == "arn:aws:iam::278311879197:root"
    error_message = "the KMS key policy must grant kms:* only to the account root"
  }
}
