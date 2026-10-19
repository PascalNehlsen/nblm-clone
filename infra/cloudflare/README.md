# infra/cloudflare

DNS for **sec-nblm.dev**, bought at the Cloudflare Registrar. Planned in the PR and applied after merge by `.github/workflows/infra-cloudflare.yml` (mirrors `infra.yml`, ADR 0009), never locally. Decisions: ADR 0013.

| File | Content |
|---|---|
| `versions.tf` | OpenTofu and provider pins (cloudflare 5.27.0); S3 backend `cloudflare/terraform.tfstate` with the same encrypted state as `infra/aws` |
| `providers.tf` | Cloudflare provider; token only from `CLOUDFLARE_API_TOKEN` |
| `dns.tf` | `app` (production, Vercel `nblm-web`) and `develop` (Vercel `nblm-web-develop`) as CNAMEs to the targets Vercel shows, never proxied; null MX, SPF `-all` and DMARC `p=reject`, because the domain sends no mail |
| `dnssec.tf` | DNSSEC on (`prevent_destroy`) |

- **Not proxied, on purpose:** Cloudflare must not see app traffic. Turnstile is the only Cloudflare processor (docs/privacy.md).
- **Tokens** (by hand, zone `sec-nblm.dev` only, 90 days, in the secrets inventory): `CLOUDFLARE_API_TOKEN` in the GitHub environment `plan` is read-only (Zone, DNS, DNSSEC read); in `infra` it can edit DNS and DNSSEC.
- **Vercel domains** are added by hand (Vercel, Settings, Domains); the CNAME targets in `dns.tf` are the values Vercel shows. `.dev` is HSTS-preloaded: a host works only after Vercel issued its certificate.
- **DNSSEC off** is not a quick revert: with Cloudflare Registrar the DS record follows the zone's DNSSEC state, and disabling moves the zone through `pending-disabled` while resolvers still hold the old DS for its TTL. Only do it in a reviewed PR (`status = "disabled"` is an in-place update that the plan guard does not block) and expect a resolution gap if signatures disappear before the DS has expired.
- **No CAA record yet:** first check which CA Vercel uses for these certificates, or issuance breaks.
