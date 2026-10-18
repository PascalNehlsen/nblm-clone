terraform {
  # Same version as scripts/tofu.sh; exact pins, upgraded on purpose.
  required_version = "1.13.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # State in the bucket from step 3, written only by the human from the host
  # (the apply role is denied bootstrap/*). docs/runbooks/bootstrap.md, step 4.
  backend "s3" {
    bucket              = "nblm-tofu-state-278311879197"
    key                 = "bootstrap/terraform.tfstate"
    region              = "eu-central-1"
    profile             = var.workload_profile
    allowed_account_ids = ["278311879197"]
    use_lockfile        = true
    encrypt             = true
    # Without kms_key_id, encrypt = true uploads with AES256 and overrides the
    # bucket's SSE-KMS default.
    kms_key_id = local.state_key_arn
  }

  # OpenTofu state and plan encryption (ADR 0003), enforced: plaintext state or
  # plan files are refused, and TF_ENCRYPTION cannot turn enforcement off.
  encryption {
    key_provider "aws_kms" "state" {
      kms_key_id = local.state_key_arn
      key_spec   = "AES_256"
      region     = "eu-central-1"
      profile    = var.workload_profile
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

# The state key ARN, not the alias: an alias can be repointed. Backend and key
# provider are evaluated at init, so this is a literal, not a resource reference.
locals {
  state_key_arn = "arn:aws:kms:eu-central-1:278311879197:key/88593446-cbdc-4378-a1b3-6b7a92c427f1"
}
