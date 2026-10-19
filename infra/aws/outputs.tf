# AWS_ROLE_ARN for each Vercel project (docs/runbooks/infra-apply.md). No secrets.

output "develop_role_arn" {
  value = aws_iam_role.web["develop"].arn
}

output "production_role_arn" {
  value = aws_iam_role.web["production"].arn
}
