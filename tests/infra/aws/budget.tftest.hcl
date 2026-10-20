# OpenTofu native test for the AWS cost budget in infra/aws/budget.tf (ops page
# PR): one monthly 10 USD cost budget in the workload account, four email
# notifications, subscriber from var.budget_alert_email. Same style as
# roles.tftest.hcl: mock provider, `command = plan` only, never `apply`.
#
# The resource address is aws_budgets_budget.monthly (the builder names it so).
#
# Run from repo root with the pinned OpenTofu binary (never plain `tofu`):
#   scripts/tofu.sh -chdir=infra/aws init -backend=false -test-directory=../../tests/infra/aws
#   scripts/tofu.sh -chdir=infra/aws test -test-directory=../../tests/infra/aws

mock_provider "aws" {}

variables {
  budget_alert_email = "budget-test@example.com"
}

run "budget_is_a_monthly_ten_usd_cost_budget" {
  command = plan

  assert {
    condition     = aws_budgets_budget.monthly.budget_type == "COST"
    error_message = "the budget must be a COST budget"
  }

  assert {
    condition     = aws_budgets_budget.monthly.time_unit == "MONTHLY"
    error_message = "the budget must reset MONTHLY"
  }

  assert {
    condition     = aws_budgets_budget.monthly.limit_unit == "USD"
    error_message = "the budget limit unit must be USD"
  }

  assert {
    condition     = aws_budgets_budget.monthly.limit_amount == "10"
    error_message = "the budget limit must be 10 USD"
  }
}

run "exactly_four_notifications_with_the_expected_thresholds" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.monthly.notification) == 4
    error_message = "the budget must have exactly four notification blocks"
  }

  assert {
    condition = toset([
      for n in aws_budgets_budget.monthly.notification : "${n.notification_type}:${n.threshold}"
    ]) == toset(["ACTUAL:50", "ACTUAL:80", "ACTUAL:100", "FORECASTED:100"])
    error_message = "notifications must be exactly ACTUAL at 50, 80, 100 and FORECASTED at 100"
  }

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification : n.threshold_type == "PERCENTAGE"
    ])
    error_message = "every notification threshold_type must be PERCENTAGE"
  }

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification : n.comparison_operator == "GREATER_THAN"
    ])
    error_message = "every notification comparison_operator must be GREATER_THAN"
  }
}

run "subscriber_is_the_variable_on_every_notification" {
  command = plan

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification :
      toset(n.subscriber_email_addresses) == toset(["budget-test@example.com"])
    ])
    error_message = "every notification must subscribe exactly var.budget_alert_email"
  }

  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification : try(length(n.subscriber_sns_topic_arns), 0) == 0
    ])
    error_message = "no notification may use an SNS topic"
  }
}

run "empty_email_is_rejected" {
  command = plan

  variables {
    budget_alert_email = ""
  }

  expect_failures = [var.budget_alert_email]
}

run "string_without_at_sign_is_rejected" {
  command = plan

  variables {
    budget_alert_email = "not-an-email"
  }

  expect_failures = [var.budget_alert_email]
}

run "email_with_whitespace_or_a_second_address_is_rejected" {
  command = plan

  variables {
    budget_alert_email = "a@example.com b@example.com"
  }

  expect_failures = [var.budget_alert_email]
}
