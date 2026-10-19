# Vercel functions reach Bedrock through these roles, by OIDC, without AWS keys
# (ADR 0009). Team issuer mode: issuer and audience name the Vercel team.
# develop is the separate project nblm-web-develop; each role trusts only the
# production environment of its own project, so no preview or development
# deployment of either project can assume it.

locals {
  vercel_team   = "pascalnehlsens-projects"
  vercel_issuer = "oidc.vercel.com/${local.vercel_team}"

  web_roles = {
    develop    = { name = "nblm-web-develop", project = "nblm-web-develop" }
    production = { name = "nblm-web-production", project = "nblm-web" }
  }

  # Titan Text Embeddings V2 in eu-central-1, called directly (no inference profile).
  embedding_model_arn = "arn:aws:bedrock:eu-central-1::foundation-model/amazon.titan-embed-text-v2:0"
}

resource "aws_iam_openid_connect_provider" "vercel" {
  url            = "https://${local.vercel_issuer}"
  client_id_list = ["https://vercel.com/${local.vercel_team}"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "web" {
  for_each = local.web_roles

  name                 = each.value.name
  max_session_duration = 3600
  assume_role_policy = templatefile("${path.module}/policies/trust-vercel.json.tftpl", {
    oidc_provider_arn = aws_iam_openid_connect_provider.vercel.arn
    issuer            = local.vercel_issuer
    audience          = "https://vercel.com/${local.vercel_team}"
    subject           = "owner:${local.vercel_team}:project:${each.value.project}:environment:production"
  })
}

# Embeddings only. Chat model permissions come with block D.
resource "aws_iam_role_policy" "web_bedrock_embeddings" {
  for_each = local.web_roles

  name = "bedrock-embeddings"
  role = aws_iam_role.web[each.key].name
  policy = templatefile("${path.module}/policies/bedrock-embeddings.json.tftpl", {
    model_arn = local.embedding_model_arn
  })
}
