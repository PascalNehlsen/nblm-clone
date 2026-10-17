# Privacy

Personal data the app stores, where it lives, and how long. Every new data processor needs an entry here (AGENTS.md).

## Processors

| Processor | Region | Data |
|---|---|---|
| Supabase (Postgres, Auth, Storage) | Frankfurt | Accounts, notebooks, memberships, membership audit |

Further processors (Vercel `fra1`, AWS Bedrock EU, Sentry EU) are added with the PRs that introduce them.

## Data

| Data | Where | Retention | On account deletion |
|---|---|---|---|
| Notebook memberships | `public.notebook_members` | While the membership exists | Deleted (foreign key cascade). A sole owner's notebooks are deleted too: account-deletion PR, open |
| Membership audit (who changed whose role, when) | `private.membership_audit`, no API access | 90 days, deleted by pg_cron: demo-login PR, open | User ids (`user_id`, `actor`) are set to null: account-deletion PR, open. No foreign keys, so the audit outlives deleted notebooks |
