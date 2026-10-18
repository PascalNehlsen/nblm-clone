# Runbook: model kill switch and budget limits

- Last rehearsed: never. The first rehearsal is enabling develop, then production, after PR E1 is deployed
- Who: the human, in the Supabase SQL editor of the project (or psql as `postgres`). Never from the sandbox or CI: neither has credentials for it ([ADR 0006](../adr/0006-model-budget-and-kill-switch.md))
- Effect: the next model call; streams already running finish. No deploy needed

## Check the current state

```sql
select model_features_enabled, daily_limit_usd, daily_limit_anonymous_usd,
       global_daily_limit_usd, updated_at, updated_by, reason
  from private.model_settings;
```

## Turn model features off (kill switch on)

```sql
update private.model_settings
   set model_features_enabled = false, updated_at = now(),
       updated_by = '<your name>', reason = '<why, incident link>';
```

Run the check above. A missing row also means off.

## Turn model features on

Same statement with `model_features_enabled = true` and a reason. Enable develop first and run the reservation test below there before enabling production.

## Change limits

```sql
update private.model_settings
   set daily_limit_usd = 0.50, daily_limit_anonymous_usd = 0.20, global_daily_limit_usd = 5.00,
       updated_at = now(), updated_by = '<your name>', reason = '<why>';
```

The anonymous limit may not exceed the per-user limit; the table rejects it, so when lowering both, set the anonymous limit first.

## Test a reservation (develop only)

The SQL editor shows only the last statement's result, so the outcome is raised as an error, which also rolls the reservation back:

```sql
do $$
declare
  test_user uuid := (select id from auth.users limit 1);  -- read before switching role
  r record;
begin
  set local role service_role;
  select * into r from public.reserve_model_call(test_user, false, null, 'chat', 'runbook-test', 0.01, 1);
  raise exception 'outcome: %', r.outcome;
end $$;
```

Expected: `ERROR: outcome: ok` when on, `ERROR: outcome: kill_switch_on` when off. `budget_exceeded` or `global_budget_exceeded` also mean the function works: the picked user or the day's total is at its limit. `user is required` means `auth.users` is empty. Nothing is stored in any case.

## Settings row missing

The check above returns no row: model features are off (fail closed), and the update statements change nothing. Restore it, then turn features on as above if intended:

```sql
insert into private.model_settings
  (model_features_enabled, daily_limit_usd, daily_limit_anonymous_usd, global_daily_limit_usd, updated_by, reason)
values (false, 0.50, 0.20, 5.00, '<your name>', '<why the row was missing>');
```

## Today's spend

```sql
select coalesce(sum(cost_usd), 0) as usd_today, count(*) as operations
  from private.usage
 where created_at >= date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
```

## After a rehearsal

Update "Last rehearsed" above with the date and environment.
