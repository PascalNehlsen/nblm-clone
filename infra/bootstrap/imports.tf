# Imports run as part of the reviewed plan and the local apply; `tofu import`
# is never needed. After the first apply these blocks are no-ops.

import {
  provider = aws.management
  to       = aws_organizations_policy.account_security
  id       = "p-ivy9gxl6"
}

import {
  provider = aws.management
  to       = aws_organizations_policy_attachment.account_security_root
  id       = "r-tmxq:p-ivy9gxl6"
}

import {
  provider = aws.management
  to       = aws_organizations_policy_attachment.legacy_region_restriction_root
  id       = "r-tmxq:p-grnvof89"
}
