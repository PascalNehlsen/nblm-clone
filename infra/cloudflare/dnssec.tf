# DNSSEC for the zone. Cloudflare Registrar manages the DS record from this state. Approved
# by Pascal on 2026-10-19 (release plan Q7, ADR 0013). Right after enabling, Cloudflare
# reports "pending" until the DS is live; the first apply may need one rerun.
resource "cloudflare_zone_dnssec" "main" {
  zone_id = local.zone_id
  # Changing this to "disabled" is an in-place update: prevent_destroy and the plan guard
  # do not stop it, only the `infra` approval does. Read the README before touching it.
  status = "active"

  lifecycle {
    prevent_destroy = true
  }
}
