terraform {
  # Same version as scripts/tofu.sh and infra/bootstrap; exact pins, upgraded on purpose.
  required_version = "1.13.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # Written only by the apply job in CI (.github/workflows/infra.yml, environment
  # `infra`). The plan role reads it with -lock=false. No profile: the job's OIDC
  # role provides the credentials (ADR 0009).
  backend "s3" {
    bucket              = "nblm-tofu-state-278311879197"
    key                 = "aws/terraform.tfstate"
    region              = "eu-central-1"
    allowed_account_ids = ["278311879197"]
    use_lockfile        = true
    encrypt             = true
    # Without kms_key_id, encrypt = true uploads with AES256 and overrides the
    # bucket's SSE-KMS default (ADR 0003).
    kms_key_id = local.state_key_arn
  }

  # OpenTofu state and plan encryption (ADR 0003), enforced from the start: the
  # saved plan uploaded between the plan and apply jobs is ciphertext.
  encryption {
    key_provider "aws_kms" "state" {
      kms_key_id = local.state_key_arn
      key_spec   = "AES_256"
      region     = "eu-central-1"
    }

    method "aes_gcm" "state" {
      keys = key_provider.aws_kms.state
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

# The state key ARN from infra/bootstrap, not the alias: an alias can be repointed.
# Backend and key provider are evaluated at init, so this is a literal.
locals {
  state_key_arn = "arn:aws:kms:eu-central-1:278311879197:key/88593446-cbdc-4378-a1b3-6b7a92c427f1"
}
