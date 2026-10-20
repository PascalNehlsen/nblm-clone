# Runbook: operator access to /ops

- Last rehearsed: not yet (after the ops page PR is merged, on develop)
- Who: the human, in the Supabase SQL editor of the project (or psql as `postgres`). Never from the sandbox or CI ([ADR 0023](../adr/0023-ops-page.md))
- Effect: the next request to `/ops`. The flag is read from the Auth server on every request, not from the session token, so revoking it works at once

The ops page shows aggregates across all users (costs, error categories, latency, the eval score). It exists only for users whose `app_metadata` carries `"ops": true`; everyone else gets a 404. Users cannot change `app_metadata` themselves. Anonymous demo users never qualify.

## Grant

Look up the user id on `/profil` ("Deine Nutzer-ID") and run:

```sql
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"ops": true}'::jsonb
 where id = '<user id>' and not is_anonymous;
```

Then open `/ops`. The page shows "Betrieb".

## Revoke

```sql
update auth.users set raw_app_meta_data = raw_app_meta_data - 'ops' where id = '<user id>';
```

`/ops` answers 404 for that user on the next request.

## Check who has access

```sql
select id, email from auth.users where raw_app_meta_data -> 'ops' = 'true'::jsonb;
```

## When the page says "Die Betriebsdaten konnten nicht geladen werden"

The app has no `SUPABASE_SECRET_KEY` (Preview never has one) or the RPC failed. The Vercel function logs show `ops store: summary failed` (a fixed line without data). Run `select public.ops_summary(7);` as `service_role` in the SQL editor (`set local role service_role;` in a transaction) to see the raw result.
