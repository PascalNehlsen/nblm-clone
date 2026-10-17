// Expected values for `infra/bootstrap/policies/scp-region-guard.json` and
// `infra/bootstrap/policies/scp-account-security.json`, transcribed by hand
// from the plan into literal arrays/objects. Deliberately does not read from
// `.scratch/`: these are the expected outcomes, not a copy of the source
// policy documents (no ARNs, account ids or describe-policy wrapper).

/** The 14 Bedrock actions that must stay reachable from every allowed region. */
export const BEDROCK_ACTIONS = [
  "bedrock-mantle:CallWithBearerToken",
  "bedrock-mantle:CreateInference",
  "bedrock-mantle:GetInference",
  "bedrock-mantle:GetModel",
  "bedrock-mantle:ListModels",
  "bedrock:ApplyGuardrail",
  "bedrock:CountTokens",
  "bedrock:GetFoundationModel",
  "bedrock:GetFoundationModelAvailability",
  "bedrock:GetInferenceProfile",
  "bedrock:InvokeModel",
  "bedrock:InvokeModelWithResponseStream",
  "bedrock:ListFoundationModels",
  "bedrock:ListInferenceProfiles",
] as const;

/**
 * The 5 AWS Identity Center action families. Human decision for PR 1: no
 * exemption for them in `DenyOutsideEuCentral1`, because Identity Center's
 * home region is eu-central-1, owned by the management account, so it does
 * not need a cross-region carve-out. Kept only so a test can assert none of
 * these families appear in that statement's `NotAction` (a regression guard,
 * not an expected value).
 */
export const IDENTITY_CENTER_FAMILIES = ["sso:*", "sso-directory:*", "sso-oauth:*", "identitystore:*", "identitystore-auth:*"] as const;

/** `DenyOutsideEuCentral1.NotAction`: exactly the 14 Bedrock actions, no Identity Center exemption. */
export const DENY_OUTSIDE_EU_CENTRAL_1_NOT_ACTION: readonly string[] = BEDROCK_ACTIONS;

/** `DenyOutsideEuCentral1` condition set: `StringNotEquals aws:RequestedRegion`. */
export const DENY_OUTSIDE_EU_CENTRAL_1_REGIONS = ["eu-central-1", "unspecified", "us-east-1"];

/**
 * `UsEast1GlobalServicesOnly.NotAction`: derived from p-grnvof89's `UsEast1Partitional.NotAction`
 * list (149 entries) minus the 14 Bedrock actions above, 135 entries. p-grnvof89 itself is not
 * imported as a policy in this PR; only its attachment to r-tmxq is (see
 * `legacy_region_restriction_root`, removed again in a later PR).
 */
export const US_EAST_1_GLOBAL_SERVICES_NOT_ACTION = [
  "a4b:*",
  "access-analyzer:*",
  "account-access:*",
  "account:*",
  "acm:*",
  "activate:*",
  "artifact:*",
  "aws-marketplace-management:*",
  "aws-marketplace:*",
  "aws-portal:*",
  "billing:*",
  "billingconductor:*",
  "budgets:*",
  "builderid:*",
  "ce:*",
  "chatbot:*",
  "chime:*",
  "cloudfront-keyvaluestore:*",
  "cloudfront:*",
  "cloudshell:*",
  "cloudtrail:LookupEvents",
  "cloudwatch:BatchGet*",
  "cloudwatch:Describe*",
  "cloudwatch:GenerateQuery",
  "cloudwatch:Get*",
  "cloudwatch:List*",
  "compute-optimizer:*",
  "config:*",
  "consoleapp:*",
  "consolidatedbilling:*",
  "cost-optimization-hub:*",
  "cur:*",
  "datapipeline:GetAccountLimits",
  "devicefarm:*",
  "directconnect:*",
  "ec2:DescribeRegions",
  "ec2:DescribeTransitGateways",
  "ec2:DescribeVpnGateways",
  "ecr-public:*",
  "finops-agent:*",
  "fms:*",
  "freetier:*",
  "globalaccelerator:*",
  "health:*",
  "iam:*",
  "identitystore-auth:*",
  "identitystore:*",
  "importexport:*",
  "invoicing:*",
  "iq:*",
  "kms:*",
  "license-manager:ListReceivedLicenses",
  "lightsail:AttachCertificateToDistribution",
  "lightsail:CreateCertificate",
  "lightsail:CreateContactMethod",
  "lightsail:CreateDistribution",
  "lightsail:CreateDomain",
  "lightsail:CreateDomainEntry",
  "lightsail:DeleteAlarm",
  "lightsail:DeleteCertificate",
  "lightsail:DeleteContactMethod",
  "lightsail:DeleteDistribution",
  "lightsail:DeleteDomain",
  "lightsail:DeleteDomainEntry",
  "lightsail:DetachCertificateFromDistribution",
  "lightsail:Get*",
  "lightsail:IsVpcPeered",
  "lightsail:PutAlarm",
  "lightsail:ResetDistributionCache",
  "lightsail:SendContactMethodVerification",
  "lightsail:SetIpAddressType",
  "lightsail:TagResource",
  "lightsail:TestAlarm",
  "lightsail:UntagResource",
  "lightsail:UpdateDistribution",
  "lightsail:UpdateDistributionBundle",
  "lightsail:UpdateDomainEntry",
  "logs:*",
  "managedblockchain-query:*",
  "managedblockchain:*",
  "mapcredits:*",
  "mobileanalytics:*",
  "networkmanager:*",
  "notifications-contacts:*",
  "notifications:*",
  "organizations:*",
  "payments:*",
  "pricing:*",
  "q:*",
  "quicksight:DescribeAccountSubscription",
  "resource-explorer-2:*",
  "route53-recovery-cluster:*",
  "route53-recovery-control-config:*",
  "route53-recovery-readiness:*",
  "route53:*",
  "route53domains:*",
  "route53globalresolver:*",
  "s3:CreateMultiRegionAccessPoint",
  "s3:DeleteMultiRegionAccessPoint",
  "s3:DescribeMultiRegionAccessPointOperation",
  "s3:GetAccountPublicAccessBlock",
  "s3:GetBucketLocation",
  "s3:GetBucketPolicyStatus",
  "s3:GetBucketPublicAccessBlock",
  "s3:GetMultiRegionAccessPoint",
  "s3:GetMultiRegionAccessPointPolicy",
  "s3:GetMultiRegionAccessPointPolicyStatus",
  "s3:GetStorageLensConfiguration",
  "s3:GetStorageLensDashboard",
  "s3:ListAllMyBuckets",
  "s3:ListMultiRegionAccessPoints",
  "s3:ListStorageLensConfigurations",
  "s3:PutAccountPublicAccessBlock",
  "s3:PutMultiRegionAccessPointPolicy",
  "savingsplans:*",
  "servicequotas:*",
  "shield:*",
  "signin:*",
  "sso-directory:*",
  "sso-oauth:*",
  "sso:*",
  "sts:*",
  "support:*",
  "supportapp:*",
  "supportplans:*",
  "sustainability:*",
  "tag:GetResources",
  "tax:*",
  "trustedadvisor:*",
  "ts:*",
  "uxc:*",
  "vendor-insights:ListEntitledSecurityProfiles",
  "waf-regional:*",
  "waf:*",
  "wafv2:*",
];

/** `BedrockInferenceEuOnly` condition set: `StringNotEquals aws:RequestedRegion`. */
export const BEDROCK_EU_REGIONS = ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"];

export const EXPECTED_SIDS = ["DenyOutsideEuCentral1", "UsEast1GlobalServicesOnly", "BedrockInferenceEuOnly"];

/**
 * The imported p-ivy9gxl6 (`ManagedAccountSecurityControlPolicy`) content,
 * transcribed literally so the import shows no diff. Deliberately excludes
 * the describe-policy wrapper (PolicySummary, Arn, account ids).
 */
export const EXPECTED_ACCOUNT_SECURITY_CONTENT = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "BlockOrgEscape",
      Effect: "Deny",
      Action: ["account:CloseAccount", "organizations:AcceptHandshake", "organizations:LeaveOrganization", "sso:CreateInstance"],
      Resource: "*",
    },
    {
      Sid: "ProtectManagedRoles",
      Effect: "Deny",
      Action: [
        "iam:AttachRolePolicy",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:DeleteRolePermissionsBoundary",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRole",
      ],
      Resource: "arn:*:iam::*:role/managed/*",
      Condition: {
        StringNotLike: {
          "aws:PrincipalArn": "arn:*:iam::*:role/managed/AWSManagedAccountManagementAccessRole",
        },
      },
    },
  ],
};
