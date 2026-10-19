# Runbook: demo template and demo jobs

- Last rehearsed: never (locally through `supabase/seed.sql`; develop after F1 is merged)
- Who: the human, in the Supabase SQL editor of the project, as `postgres` ([ADR 0012](../adr/0012-demo-login.md))
- What: register the notebook that demo users get a copy of, change the cap, switch copies off, check the pg_cron jobs

## Prepare the template

1. Sign in to the app with GitHub, create a notebook (for example "Demo: Beispielquellen") and add 2 to 3 short public-domain German texts as pasted text (for example excerpts of German statutes, which § 5 UrhG leaves unprotected). Keep it at 50 chunks or fewer.
2. Wait until every source shows "Bereit". Only ready sources are copied.
3. Copy the notebook id from the URL (`/notebooks/<id>`).

## Register or replace the template

```sql
insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
values ('<notebook id>', 100, '<your name>', '<why>')
on conflict (id) do update
   set notebook_id = excluded.notebook_id, updated_at = now(),
       updated_by = excluded.updated_by, reason = excluded.reason;
```

## Change the cap

```sql
update private.demo_template
   set max_live_copies = 100, updated_at = now(), updated_by = '<your name>', reason = '<why>';
```

## Switch demo copies off

Fastest: Authentication, Sign In / Providers, Anonymous sign-ins off (no new demo users). To stop copies only: `delete from private.demo_template;` (new anonymous notebooks then fail with "demo_unavailable").

## Check the jobs

```sql
select jobname, schedule, command, active from cron.job order by jobname;
select jobid, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;
```

Expected jobs: `nblm-purge-demo-users` (`*/15 * * * *`), `nblm-membership-audit-retention` (`17 3 * * *`), `nblm-usage-retention` (`27 3 * * *`). To pause one: `select cron.unschedule('<jobname>');` (a later migration or this runbook schedules it again).

## Live demo users

```sql
select count(*) as live_demo_users from auth.users where is_anonymous is true;
```
