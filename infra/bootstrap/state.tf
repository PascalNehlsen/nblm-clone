# Remote state for every stack: one bucket, encrypted with its own KMS key.
# Workload account (default provider). Bootstrap's own state moves here in the
# migration step (docs/runbooks/bootstrap.md).

locals {
  account_id = "278311879197"
}

resource "aws_kms_key" "state" {
  description             = "OpenTofu state: S3 encryption and OpenTofu state encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # Account root only: IAM policies decide who may use the key, and nobody can
  # lock the account out of it.
  policy = templatefile("${path.module}/policies/kms-state-key.json.tftpl", {
    account_id = local.account_id
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = "alias/nblm-tofu-state"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  bucket = "nblm-tofu-state-278311879197"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

# Old state versions are the undo for a bad apply; 90 days is enough to notice.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "state-history"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = templatefile("${path.module}/policies/state-bucket.json.tftpl", {
    bucket_arn = aws_s3_bucket.state.arn
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}
