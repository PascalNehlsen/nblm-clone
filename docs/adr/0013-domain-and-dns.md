# 0013: sec-nblm.dev DNS from OpenTofu, unproxied, with DNSSEC

- Status: accepted
- Date: 2026-10-19

## Context

The app gets its own domain, `sec-nblm.dev`, bought at the Cloudflare Registrar with the zone left untouched so it is managed as code. Production (`nblm-web`) and develop (`nblm-web-develop`) run on Vercel. Every infra change goes through OpenTofu with a plan in the PR and an approved apply in CI (ADR 0009). Cloudflare has no OIDC for GitHub Actions.

## Decision

- **Stack** `infra/cloudflare`: the zone is a data source (this stack cannot delete it); CNAMEs `app` and `develop` to the targets Vercel shows; null MX, SPF `-all` and DMARC `p=reject` because the domain sends no mail; DNSSEC on with `prevent_destroy`.
- **Never proxied**: Cloudflare must not see app traffic, or it becomes a processor of every request. Turnstile stays the only Cloudflare processor.
- **Pipeline**: `.github/workflows/infra-cloudflare.yml`, a copy of `infra.yml` (same environments, encrypted saved plan, plan guard before apply). A separate file instead of a matrix in `infra.yml` keeps the AWS pipeline untouched; the state shares the encrypted S3 backend, so the AWS plan and apply roles still run the jobs.
- **Tokens** by hand, zone-scoped, 90 days: read in `plan`, edit in `infra`, only on the Init, Plan and Apply steps.
- **Vercel domains** are added by hand once; the CI tokens need no domain rights.

## Consequences

- DNS changes are reviewed like AWS changes; deletes and replaces stop at the plan guard.
- DNSSEC is hard to turn off again (README); disabling it is an in-place update that only the `infra` approval gates.
- Two more long-lived secrets to rotate every 90 days.
- No CAA record until Vercel's certificate authority is checked.

## Alternatives considered

- **Matrix in `infra.yml`**: one file, but per-stack outputs between jobs (artifact, changes) complicate the existing gate.
- **Vercel DNS (nameservers at Vercel)**: the zone would leave OpenTofu and Cloudflare Registrar's DNSSEC handling.
- **Proxied records**: Cloudflare features at the price of routing all user traffic through it.
