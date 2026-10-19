# allowed_account_ids makes a plan with the wrong credentials fail before it reads anything.

provider "aws" {
  region              = "eu-central-1"
  allowed_account_ids = ["278311879197"]

  default_tags {
    tags = {
      project    = "nblm-clone"
      stack      = "aws"
      managed-by = "opentofu"
    }
  }
}
