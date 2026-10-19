# DNS for sec-nblm.dev (bought at the Cloudflare Registrar; the zone is managed only here).
# Records point to Vercel and are never proxied: Cloudflare must not see app traffic
# (it would become a processor of every request). `.dev` is HSTS-preloaded, so the sites
# work only once Vercel has issued their certificates.

data "cloudflare_zone" "main" {
  filter = {
    name = "sec-nblm.dev"
  }
}

locals {
  zone_id = data.cloudflare_zone.main.id

  # Targets as Vercel shows them for each domain (Settings, Domains). Not secret.
  app_records = {
    app     = { type = "CNAME", content = "b5093e33db6b899c.vercel-dns-017.com" }
    develop = { type = "CNAME", content = "91b5b9a2cec5b2a9.vercel-dns-017.com" }
  }

  # The domain sends no mail: a null MX, SPF that allows no sender, and DMARC that rejects
  # everything, so nobody can send mail as sec-nblm.dev.
  mail_records = {
    null_mx = { name = "sec-nblm.dev", type = "MX", content = ".", priority = 0 }
    spf     = { name = "sec-nblm.dev", type = "TXT", content = "\"v=spf1 -all\"", priority = null }
    dmarc   = { name = "_dmarc.sec-nblm.dev", type = "TXT", content = "\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\"", priority = null }
  }
}

resource "cloudflare_dns_record" "app" {
  for_each = local.app_records

  zone_id = local.zone_id
  # Full names: the API returns them, so short names could show a diff on every plan.
  name    = "${each.key}.sec-nblm.dev"
  type    = each.value.type
  content = each.value.content
  ttl     = 1 # automatic
  proxied = false

  lifecycle {
    precondition {
      condition     = !startswith(each.value.content, "REPLACE_")
      error_message = "Set the Vercel target for ${each.key}.sec-nblm.dev (Vercel, Settings, Domains)."
    }
  }
}

resource "cloudflare_dns_record" "mail" {
  for_each = local.mail_records

  zone_id  = local.zone_id
  name     = each.value.name
  type     = each.value.type
  content  = each.value.content
  priority = each.value.priority
  ttl      = 1
  proxied  = false
}
