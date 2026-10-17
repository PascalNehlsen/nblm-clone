# Service control policies on the organization root (r-tmxq, no OUs).
# FullAWSAccess stays attached to the root and to every account; it is not managed here.

# Replaces the wizard's p-grnvof89: eu-central-1 fully, global services in
# us-east-1, Bedrock inference in the EU regions of the eu.* inference profiles.
resource "aws_organizations_policy" "region_guard" {
  provider    = aws.management
  name        = "nblm-region-guard"
  description = "Allow eu-central-1, global services in us-east-1 and Bedrock inference in EU regions only"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(jsondecode(file("${path.module}/policies/scp-region-guard.json")))

  tags = {
    project    = "nblm-clone"
    stack      = "bootstrap"
    managed-by = "opentofu"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_organizations_policy_attachment" "region_guard_root" {
  provider  = aws.management
  policy_id = aws_organizations_policy.region_guard.id
  target_id = "r-tmxq"

  lifecycle {
    prevent_destroy = true
  }
}

# p-ivy9gxl6 from the account wizard, imported unchanged (content, name, no tags): blocks leaving the
# org, closing accounts, sso:CreateInstance and changes to role/managed/*.
resource "aws_organizations_policy" "account_security" {
  provider    = aws.management
  name        = "ManagedAccountSecurityControlPolicy"
  description = "ManagedAccountSecurityControlPolicy"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(jsondecode(file("${path.module}/policies/scp-account-security.json")))

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_organizations_policy_attachment" "account_security_root" {
  provider  = aws.management
  policy_id = aws_organizations_policy.account_security.id
  target_id = "r-tmxq"

  lifecycle {
    prevent_destroy = true
  }
}

# The wizard's region SCP p-grnvof89 stays attached until nblm-region-guard is
# verified. While both are attached, the allowed set is their intersection.
# The next step removes this block, which detaches it; the policy itself is
# deleted in a later PR. No prevent_destroy on purpose.
resource "aws_organizations_policy_attachment" "legacy_region_restriction_root" {
  provider  = aws.management
  policy_id = "p-grnvof89"
  target_id = "r-tmxq"
}
