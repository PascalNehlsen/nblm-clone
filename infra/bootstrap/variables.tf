# AWS CLI profiles (sso-session nblm) on the host of the human who applies.
# Names only, no credentials.

variable "workload_profile" {
  description = "AWS CLI profile with admin rights in the workload account."
  type        = string
  default     = "nblm-workload"
}

variable "management_profile" {
  description = "AWS CLI profile with admin rights in the management account."
  type        = string
  default     = "nblm-mgmt-admin"
}
