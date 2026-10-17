# allowed_account_ids makes a plan with the wrong profile fail before it reads anything.

provider "aws" {
  region              = "eu-central-1"
  profile             = var.workload_profile
  allowed_account_ids = ["278311879197"]

  default_tags {
    tags = {
      project    = "nblm-clone"
      stack      = "bootstrap"
      managed-by = "opentofu"
    }
  }
}

# Organizations and SCPs live in the management account, where SCPs do not apply.
provider "aws" {
  alias               = "management"
  region              = "eu-central-1"
  profile             = var.management_profile
  allowed_account_ids = ["482146446868"]

  # No default_tags here: they would tag the imported wizard policy p-ivy9gxl6,
  # which stays unchanged. Resources created here set tags explicitly.
}
