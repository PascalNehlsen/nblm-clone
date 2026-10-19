output "zone_id" {
  value = local.zone_id
}

output "app_hostnames" {
  value = [for name, _ in local.app_records : "${name}.sec-nblm.dev"]
}
