# GitHub Actions reaches AWS only through these two roles, by OIDC, without keys.
# Subjects use the immutable form (owner and repo ids), so a renamed or
# re-created repository with the same name cannot assume them.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  lifecycle {
    prevent_destroy = true
  }
}

# Plan for pull requests: config reads (SecurityAudit) and state reads, no writes.
# Trusts only jobs in the GitHub environment `plan` (required reviewer), never
# plain pull_request runs: anyone who can push a branch, agents included, could
# otherwise run their own code with this role through CI.
resource "aws_iam_role" "tofu_plan" {
  name                 = "nblm-tofu-plan"
  max_session_duration = 3600
  assume_role_policy = templatefile("${path.module}/policies/trust-github-plan.json.tftpl", {
    oidc_provider_arn = aws_iam_openid_connect_provider.github.arn
  })
}

resource "aws_iam_role_policy_attachment" "tofu_plan_security_audit" {
  role       = aws_iam_role.tofu_plan.name
  policy_arn = "arn:aws:iam::aws:policy/SecurityAudit"
}

resource "aws_iam_role_policy" "tofu_plan_state_read" {
  name = "state-read"
  role = aws_iam_role.tofu_plan.id
  policy = templatefile("${path.module}/policies/plan-state-read.json.tftpl", {
    bucket_arn = aws_s3_bucket.state.arn
    key_arn    = aws_kms_key.state.arn
  })
}

# Apply after merge, only from the GitHub environment `infra`. The real gate is
# that environment's required reviewer (ADR 0002); the guard below is a speed bump.
resource "aws_iam_role" "tofu_apply" {
  name                 = "nblm-tofu-apply"
  max_session_duration = 3600
  assume_role_policy = templatefile("${path.module}/policies/trust-github-apply.json.tftpl", {
    oidc_provider_arn = aws_iam_openid_connect_provider.github.arn
  })
}

resource "aws_iam_role_policy_attachment" "tofu_apply_admin" {
  role       = aws_iam_role.tofu_apply.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_role_policy" "tofu_apply_guard" {
  name = "guard"
  role = aws_iam_role.tofu_apply.id
  policy = templatefile("${path.module}/policies/apply-guard.json.tftpl", {
    bucket_arn        = aws_s3_bucket.state.arn
    key_arn           = aws_kms_key.state.arn
    plan_role_arn     = aws_iam_role.tofu_plan.arn
    apply_role_arn    = aws_iam_role.tofu_apply.arn
    key_alias_arn     = aws_kms_alias.state.arn
    oidc_provider_arn = aws_iam_openid_connect_provider.github.arn
  })
}
