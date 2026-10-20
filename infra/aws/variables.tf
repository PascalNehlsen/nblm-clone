# Where budget alerts go. Personal data, not a secret: it comes from the GitHub variable
# BUDGET_ALERT_EMAIL of the `plan` environment (TF_VAR_budget_alert_email on the plan steps),
# never from the repo. Sensitive, so the address is redacted from the plan in the job summary.
variable "budget_alert_email" {
  type        = string
  sensitive   = true
  description = "Email address for the monthly AWS cost budget alerts."

  validation {
    condition     = can(regex("^[^@[:space:],;]+@[^@[:space:],;]+\\.[^@[:space:],;]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be a single email address."
  }
}
