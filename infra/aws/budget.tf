# Monthly AWS cost budget for the workload account (ops page PR, Pascal 2026-10-20). Alerts
# only, no budget actions: the hard cost controls are the per-user and global model budgets
# and the kill switch (ADR 0006). Bedrock is the only real spend; normal use is cents a day.
# The Budgets API is global (us-east-1); the region guard SCP allows budgets:* there.

locals {
  budget_limit_usd = "10"
}

resource "aws_budgets_budget" "monthly" {
  name         = "nblm-monthly-cost"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = local.budget_limit_usd
  limit_unit   = "USD"

  notification {
    notification_type          = "ACTUAL"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    comparison_operator        = "GREATER_THAN"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    notification_type          = "ACTUAL"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    comparison_operator        = "GREATER_THAN"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    notification_type          = "ACTUAL"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    comparison_operator        = "GREATER_THAN"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    comparison_operator        = "GREATER_THAN"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
