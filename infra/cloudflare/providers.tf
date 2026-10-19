# The API credential comes from CLOUDFLARE_API_TOKEN, set only on the Init/Plan/Apply steps of
# the cloudflare jobs: a zone-scoped read credential in `plan`, an edit credential in `infra` (ADR 0013).
provider "cloudflare" {}
