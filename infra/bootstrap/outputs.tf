# Values the other stacks and the CI workflows need. No secrets.

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "state_key_arn" {
  value = aws_kms_key.state.arn
}

output "state_key_alias" {
  value = aws_kms_alias.state.name
}

output "plan_role_arn" {
  value = aws_iam_role.tofu_plan.arn
}

output "apply_role_arn" {
  value = aws_iam_role.tofu_apply.arn
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}
