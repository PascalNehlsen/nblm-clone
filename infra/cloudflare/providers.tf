# The token comes from CLOUDFLARE_API_TOKEN, set only on the Init/Plan/Apply steps of the
# cloudflare jobs: a zone-scoped read token in `plan`, an edit token in `infra` (ADR 0013).
provider "cloudflare" {}
