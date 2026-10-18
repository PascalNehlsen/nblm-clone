# 0003: State and plan files are encrypted by OpenTofu with the state KMS key

- Status: accepted
- Date: 2026-10-18

## Context

Bootstrap state moves from the host into the state bucket (ADR 0002, runbook step 4). The bucket already encrypts objects with SSE-KMS, but that protects only the object at rest in S3: plan files, CI artifacts and any downloaded copy are plaintext JSON. OpenTofu state and plan encryption adds a client-side layer. Two facts from the OpenTofu 1.13.1 source shape the decision: the `aws_kms` key provider calls `kms:GenerateDataKey` on every run, also when it only reads (`internal/encryption/keyprovider/aws_kms/provider.go`), and the S3 backend with `encrypt = true` but no `kms_key_id` uploads with `AES256`, which overrides the bucket's SSE-KMS default.

## Decision

- Bootstrap uses `backend "s3"` (`bootstrap/terraform.tfstate`, `use_lockfile = true`, `encrypt = true`, `kms_key_id` set). The key ARN is defined once as `local.state_key_arn` and used by the backend and the key provider. It is the key ARN, not the alias, because an alias can be repointed.
- State and plan files use `aes_gcm` with the `aws_kms` key provider on the state key. This PR keeps an `unencrypted` fallback so the existing plaintext state can be read during the migration. PR 5 removes the fallback and sets `enforced = true`.
- The plan role gets `kms:GenerateDataKey` on the state key only, without a condition (there is no data key spec condition key, and the provider sends no encryption context). Plan files stay encrypted. Without this permission the plan role could not read encrypted state at all, so unencrypted plan files would not remove the need.
- The plan role still cannot write to the bucket. CI plans run with `-lock=false`; a role that may create `.tflock` objects could leave a stale lock and block every apply. Applying a saved plan fails if state changed after it was made, so a plan without a lock cannot apply stale data.
- The apply role's deny on `bootstrap/*` stays: CI can read bootstrap state but never write it, so bootstrap applies stay local by design (ADR 0002).

## Consequences

Plan files and state copies outside S3 are ciphertext, and after PR 5 OpenTofu refuses plaintext or tampered state, but integrity holds only against principals without access to the key: anyone with `kms:Decrypt` or `kms:GenerateDataKey` on it can produce ciphertext that OpenTofu accepts. Both layers use the same key, so a principal with `s3:GetObject` and `kms:Decrypt` still reads everything; the plan role is such a principal and stays gated by the `plan` environment. Losing the key loses all state: `prevent_destroy`, the 30-day deletion window, the apply guard and the plaintext backup until PR 5 cover that. KMS requests cost well under 1 USD a month. Revisit if OpenTofu changes the key provider to skip `GenerateDataKey` on reads, or if a second key per stack becomes necessary.

## Alternatives considered

- **SSE-KMS only, no OpenTofu encryption**: plan files and CI artifacts would hold plaintext state.
- **Unencrypted plan files, plan role without `GenerateDataKey`**: does not work, reading encrypted state needs it.
- **`pbkdf2` passphrase key provider**: a long-lived secret in GitHub and on the host, rotated by hand.
- **Allow the plan role to write `*.tflock`**: a stale lock from a plan job could block applies.
- **Alias in `kms_key_id`**: repointable by an admin, and it does not match the key ARN in the IAM policies.
