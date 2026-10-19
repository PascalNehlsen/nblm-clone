terraform {
  # Same version as scripts/tofu.sh and the other stacks; exact pins, upgraded on purpose.
  required_version = "1.13.1"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # 5.27.0 (2026-10-03): past the two-week cooldown; 5.28.0 was too new.
      version = "5.27.0"
    }
  }

  # Same bucket, lockfile and encryption as infra/aws (ADR 0003, 0009), own key. The AWS
  # credentials come from the job's OIDC role; Cloudflare's from CLOUDFLARE_API_TOKEN.
  backend "s3" {
    bucket              = "nblm-tofu-state-278311879197"
    key                 = "cloudflare/terraform.tfstate"
    region              = "eu-central-1"
    allowed_account_ids = ["278311879197"]
    use_lockfile        = true
    encrypt             = true
    kms_key_id          = local.state_key_arn
  }

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

locals {
  state_key_arn = "arn:aws:kms:eu-central-1:278311879197:key/88593446-cbdc-4378-a1b3-6b7a92c427f1"
}
