# OpenTofu native test for the new infra/aws stack (PR A,
# infra/aws-pipeline-and-roles): the Vercel OIDC provider, the two per-env web
# roles it can assume, and each role's inline Bedrock-embeddings permissions
# policy. Same style as tests/infra/bootstrap/*.tftest.hcl: mock provider,
# `command = plan` only, never `apply`.
#
# Run from repo root with the pinned OpenTofu binary (never plain `tofu`):
#   scripts/tofu.sh -chdir=infra/aws init -backend=false -test-directory=../../tests/infra/aws
#   scripts/tofu.sh -chdir=infra/aws test -test-directory=../../tests/infra/aws

mock_provider "aws" {}

# var.budget_alert_email (infra/aws/budget.tf) has no default, so every run in
# this file needs a value. Not used by any assertion below.
variables {
  budget_alert_email = "budget-test@example.com"
}

# Top-level `locals` blocks are not part of the .tftest.hcl grammar, so the
# overridden OIDC provider arn below is a repeated literal, the same pattern
# tests/infra/bootstrap/state.tftest.hcl uses for its mock key/bucket arns.

run "oidc_provider_is_configured_for_vercel_only" {
  command = plan

  assert {
    condition     = aws_iam_openid_connect_provider.vercel.url == "https://oidc.vercel.com/pascalnehlsens-projects"
    error_message = "the OIDC provider must point at the pascalnehlsens-projects Vercel issuer"
  }

  assert {
    condition     = toset(aws_iam_openid_connect_provider.vercel.client_id_list) == toset(["https://vercel.com/pascalnehlsens-projects"])
    error_message = "the OIDC provider's client_id_list (audience) must be exactly the Vercel team URL"
  }
}

run "exactly_the_develop_and_production_keys_exist" {
  command = plan

  override_resource {
    target = aws_iam_openid_connect_provider.vercel
    values = {
      arn = "arn:aws:iam::278311879197:oidc-provider/oidc.vercel.com/pascalnehlsens-projects"
    }
  }

  assert {
    condition     = toset(keys(aws_iam_role.web)) == toset(["develop", "production"])
    error_message = "aws_iam_role.web must have exactly the for_each keys develop and production"
  }

  assert {
    condition     = toset(keys(aws_iam_role_policy.web_bedrock_embeddings)) == toset(["develop", "production"])
    error_message = "aws_iam_role_policy.web_bedrock_embeddings must have exactly the for_each keys develop and production"
  }
}

run "develop_role_name_duration_and_trust" {
  command = plan

  override_resource {
    target = aws_iam_openid_connect_provider.vercel
    values = {
      arn = "arn:aws:iam::278311879197:oidc-provider/oidc.vercel.com/pascalnehlsens-projects"
    }
  }

  assert {
    condition     = aws_iam_role.web["develop"].name == "nblm-web-develop"
    error_message = "the develop role must be named nblm-web-develop"
  }

  assert {
    condition     = aws_iam_role.web["develop"].max_session_duration == 3600
    error_message = "the develop role must cap sessions at 3600 seconds"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement) == 1
    error_message = "the develop role's trust policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Effect == "Allow"
    error_message = "the develop role's trust statement must Allow"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
    error_message = "the develop role's trust statement must allow only sts:AssumeRoleWithWebIdentity"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::278311879197:oidc-provider/oidc.vercel.com/pascalnehlsens-projects"
    error_message = "the develop role must trust exactly the Vercel OIDC provider"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Condition)) == toset(["StringEquals"])
    error_message = "the develop role's trust statement must have exactly one Condition operator, StringEquals"
  }

  assert {
    condition = toset(keys(jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Condition.StringEquals)) == toset([
      "oidc.vercel.com/pascalnehlsens-projects:aud",
      "oidc.vercel.com/pascalnehlsens-projects:sub",
    ])
    error_message = "the develop role's StringEquals must check exactly the aud and sub claims for this issuer"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/pascalnehlsens-projects:aud"] == "https://vercel.com/pascalnehlsens-projects"
    error_message = "the develop role's aud condition must equal the Vercel team URL"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["develop"].assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/pascalnehlsens-projects:sub"] == "owner:pascalnehlsens-projects:project:nblm-web-develop:environment:production"
    error_message = "the develop role's sub condition must pin the develop Vercel project in its production environment"
  }

  assert {
    condition     = !strcontains(aws_iam_role.web["develop"].assume_role_policy, "preview")
    error_message = "the develop role's trust policy must not mention a preview Vercel environment"
  }

  assert {
    condition     = !strcontains(aws_iam_role.web["develop"].assume_role_policy, "development")
    error_message = "the develop role's trust policy must not mention a development Vercel environment"
  }

  assert {
    condition     = !strcontains(aws_iam_role.web["develop"].assume_role_policy, "*")
    error_message = "the develop role's trust policy must not contain a wildcard"
  }
}

run "production_role_name_duration_and_trust" {
  command = plan

  override_resource {
    target = aws_iam_openid_connect_provider.vercel
    values = {
      arn = "arn:aws:iam::278311879197:oidc-provider/oidc.vercel.com/pascalnehlsens-projects"
    }
  }

  assert {
    condition     = aws_iam_role.web["production"].name == "nblm-web-production"
    error_message = "the production role must be named nblm-web-production"
  }

  assert {
    condition     = aws_iam_role.web["production"].max_session_duration == 3600
    error_message = "the production role must cap sessions at 3600 seconds"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement) == 1
    error_message = "the production role's trust policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Effect == "Allow"
    error_message = "the production role's trust statement must Allow"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity"
    error_message = "the production role's trust statement must allow only sts:AssumeRoleWithWebIdentity"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::278311879197:oidc-provider/oidc.vercel.com/pascalnehlsens-projects"
    error_message = "the production role must trust exactly the Vercel OIDC provider"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Condition)) == toset(["StringEquals"])
    error_message = "the production role's trust statement must have exactly one Condition operator, StringEquals"
  }

  assert {
    condition = toset(keys(jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Condition.StringEquals)) == toset([
      "oidc.vercel.com/pascalnehlsens-projects:aud",
      "oidc.vercel.com/pascalnehlsens-projects:sub",
    ])
    error_message = "the production role's StringEquals must check exactly the aud and sub claims for this issuer"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/pascalnehlsens-projects:aud"] == "https://vercel.com/pascalnehlsens-projects"
    error_message = "the production role's aud condition must equal the Vercel team URL"
  }

  assert {
    condition     = jsondecode(aws_iam_role.web["production"].assume_role_policy).Statement[0].Condition.StringEquals["oidc.vercel.com/pascalnehlsens-projects:sub"] == "owner:pascalnehlsens-projects:project:nblm-web:environment:production"
    error_message = "the production role's sub condition must pin the nblm-web Vercel project in its production environment"
  }

  assert {
    condition     = !strcontains(aws_iam_role.web["production"].assume_role_policy, "preview")
    error_message = "the production role's trust policy must not mention a preview Vercel environment"
  }

  assert {
    condition     = !strcontains(aws_iam_role.web["production"].assume_role_policy, "development")
    error_message = "the production role's trust policy must not mention a development Vercel environment"
  }

  assert {
    condition     = !strcontains(aws_iam_role.web["production"].assume_role_policy, "*")
    error_message = "the production role's trust policy must not contain a wildcard"
  }
}

run "develop_permissions_policy_grants_only_bedrock_invoke_on_the_embedding_model" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.web_bedrock_embeddings["develop"].name == "bedrock-embeddings"
    error_message = "develop: the inline policy must be named bedrock-embeddings"
  }

  assert {
    condition     = aws_iam_role_policy.web_bedrock_embeddings["develop"].role == aws_iam_role.web["develop"].name
    error_message = "develop: the inline policy's role must be the role's own name, not a hardcoded or cross-env value"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement) == 1
    error_message = "develop: the permissions policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement[0].Effect == "Allow"
    error_message = "develop: the permissions statement must Allow"
  }

  assert {
    condition     = flatten([jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement[0].Action]) == ["bedrock:InvokeModel"]
    error_message = "develop: the permissions statement must allow exactly bedrock:InvokeModel"
  }

  assert {
    condition     = flatten([jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement[0].Resource]) == ["arn:aws:bedrock:eu-central-1::foundation-model/amazon.titan-embed-text-v2:0"]
    error_message = "develop: the permissions statement must be scoped to exactly the Titan embeddings model"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement :
      !contains(keys(s), "NotAction") && !contains(keys(s), "NotResource")
    ])
    error_message = "develop: no statement may use NotAction or NotResource"
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement : [
        for a in flatten([s.Action]) : !strcontains(a, "*")
      ]
    ]))
    error_message = "develop: no Action value may contain a wildcard"
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.web_bedrock_embeddings["develop"].policy).Statement : [
        for r in flatten([s.Resource]) : !strcontains(r, "*")
      ]
    ]))
    error_message = "develop: no Resource value may contain a wildcard"
  }
}

run "production_permissions_policy_grants_only_bedrock_invoke_on_the_embedding_model" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.web_bedrock_embeddings["production"].name == "bedrock-embeddings"
    error_message = "production: the inline policy must be named bedrock-embeddings"
  }

  assert {
    condition     = aws_iam_role_policy.web_bedrock_embeddings["production"].role == aws_iam_role.web["production"].name
    error_message = "production: the inline policy's role must be the role's own name, not a hardcoded or cross-env value"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement) == 1
    error_message = "production: the permissions policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement[0].Effect == "Allow"
    error_message = "production: the permissions statement must Allow"
  }

  assert {
    condition     = flatten([jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement[0].Action]) == ["bedrock:InvokeModel"]
    error_message = "production: the permissions statement must allow exactly bedrock:InvokeModel"
  }

  assert {
    condition     = flatten([jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement[0].Resource]) == ["arn:aws:bedrock:eu-central-1::foundation-model/amazon.titan-embed-text-v2:0"]
    error_message = "production: the permissions statement must be scoped to exactly the Titan embeddings model"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement :
      !contains(keys(s), "NotAction") && !contains(keys(s), "NotResource")
    ])
    error_message = "production: no statement may use NotAction or NotResource"
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement : [
        for a in flatten([s.Action]) : !strcontains(a, "*")
      ]
    ]))
    error_message = "production: no Action value may contain a wildcard"
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.web_bedrock_embeddings["production"].policy).Statement : [
        for r in flatten([s.Resource]) : !strcontains(r, "*")
      ]
    ]))
    error_message = "production: no Resource value may contain a wildcard"
  }
}
