terraform {
  # Same version as scripts/tofu.sh; exact pins, upgraded on purpose.
  required_version = "1.13.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # No backend yet: state stays local on the host until the state bucket exists
  # and the migration step moves it there (docs/runbooks/bootstrap.md).
}
