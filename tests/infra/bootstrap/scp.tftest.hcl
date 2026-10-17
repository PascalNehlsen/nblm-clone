# OpenTofu native test for infra/bootstrap, PR 2 (infra/bootstrap-detach).
# PR 1's imports are applied, so there are no `import` blocks left and
# `tofu test` with mock providers works (import blocks make it panic with
# "Importing is not supported in testing context", which is why this file
# did not exist while PR 1's imports.tf was still present).
#
# Run from repo root with the pinned OpenTofu binary (never plain `tofu`):
#   scripts/tofu.sh -chdir=infra/bootstrap init -backend=false -test-directory=../../tests/infra/bootstrap
#   scripts/tofu.sh -chdir=infra/bootstrap test -test-directory=../../tests/infra/bootstrap

mock_provider "aws" {}

mock_provider "aws" {
  alias = "management"
}

# Smoke test only: proves the config plans against the real aws provider
# schema (attribute names, types). The region-guard/account-security policy
# JSON semantics (shape, Sids, actions, conditions) are covered in
# tests/unit/infra, not here, because mocked policy content can't be made to
# round-trip meaningfully (see the plan run below for what mocking buys us
# instead: catching a wrong policy_id wiring).
run "plans_successfully" {
  command = plan

  assert {
    condition     = aws_organizations_policy.region_guard.type == "SERVICE_CONTROL_POLICY"
    error_message = "region_guard must be a SERVICE_CONTROL_POLICY"
  }
}

# Proves each attachment references its own policy, not the other one.
# `plan`, not `apply`: the override_resource ids are already in the plan, so
# the asserts below are already meaningful, and apply is avoided because the
# resources' `prevent_destroy` blocks tofu test's cleanup destroy afterwards,
# which leaves an `errored_test.tfstate` behind while still exiting 0 (a
# silent leftover). Overriding each policy's id to a distinct, recognisable
# mock value means the attachments can only get the right policy_id by
# referencing the right resource; swapping policy_id between the two
# attachments in scp.tf makes both asserts below fail.
run "attachments_reference_the_right_policies" {
  command = plan

  override_resource {
    target = aws_organizations_policy.region_guard
    values = {
      id = "p-mockregion"
    }
  }

  override_resource {
    target = aws_organizations_policy.account_security
    values = {
      id = "p-mocksecurity"
    }
  }

  assert {
    condition     = aws_organizations_policy_attachment.region_guard_root.policy_id == "p-mockregion"
    error_message = "region_guard_root must attach region_guard, not account_security"
  }

  assert {
    condition     = aws_organizations_policy_attachment.account_security_root.policy_id == "p-mocksecurity"
    error_message = "account_security_root must attach account_security, not region_guard"
  }
}
