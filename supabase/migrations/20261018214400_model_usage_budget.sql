-- PR E1: model usage, daily budget and kill switch (ADR 0006).
-- Only the server writes usage: both functions are security invoker and executable by
-- service_role alone, so no signed-in user can reserve, settle or read usage through
-- the API. ADR 0001 is unchanged: no new security definer function.
-- Adds objects only; the deployed app does not use them yet.

-- Settings: one row, read on every reservation, changed only by a human with SQL access
-- (runbook docs/runbooks/kill-switch.md). Seeded with model features off.
create table private.model_settings (
  id boolean primary key default true check (id),
  model_features_enabled boolean not null,
  daily_limit_usd numeric(10, 4) not null check (daily_limit_usd > 0),
  daily_limit_anonymous_usd numeric(10, 4) not null
    check (daily_limit_anonymous_usd > 0 and daily_limit_anonymous_usd <= daily_limit_usd),
  global_daily_limit_usd numeric(10, 4) not null check (global_daily_limit_usd > 0),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  reason text
);

insert into private.model_settings
  (model_features_enabled, daily_limit_usd, daily_limit_anonymous_usd, global_daily_limit_usd, updated_by, reason)
values
  (false, 0.50, 0.20, 5.00, 'migration', 'Seeded off; each environment is enabled through the runbook');

-- One row per logical model operation (a source's embeddings, a chat turn). No prompt,
-- source or answer text. Rows outlive their user, notebook and message (set null), so
-- cost per day stays correct after deletions.
create table private.usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  notebook_id uuid references public.notebooks (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  kind text not null check (kind in ('embedding', 'chat')),
  model_id text not null check (char_length(model_id) between 1 and 200),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'failed')),
  call_count integer not null default 1 check (call_count >= 1),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  -- The estimate while reserved, the actual cost once settled or failed.
  cost_usd numeric(20, 12) not null check (cost_usd >= 0),
  latency_ms integer check (latency_ms >= 0),
  error_category text check (error_category ~ '^[a-z_]{1,40}$'),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (
    status = 'reserved'
    or (input_tokens is not null and output_tokens is not null
        and latency_ms is not null and settled_at is not null)
  )
);

create index usage_user_created_at_idx on private.usage (user_id, created_at) include (cost_usd);
create index usage_created_at_idx on private.usage (created_at) include (cost_usd);
create index usage_message_id_idx on private.usage (message_id);
create index usage_notebook_id_idx on private.usage (notebook_id);

alter table private.model_settings enable row level security;
alter table private.usage enable row level security;

-- Grants: nothing for API roles. service_role reads settings, inserts only what a
-- reservation sets (status, created_at and settled_at keep their defaults) and updates
-- only what settle sets. No delete: rows go away only by retention (PR F).
revoke all on private.model_settings, private.usage from public, anon, authenticated;
grant usage on schema private to service_role;
grant select on private.model_settings to service_role;
grant select on private.usage to service_role;
grant insert (user_id, notebook_id, kind, model_id, call_count, cost_usd) on private.usage to service_role;
grant update (status, input_tokens, output_tokens, cost_usd, latency_ms, message_id, error_category, settled_at)
  on private.usage to service_role;

-- Policies: deny all for authenticated (service_role bypasses RLS) ---------------------

create policy model_settings_select on private.model_settings
  for select to authenticated using (false);
create policy model_settings_insert on private.model_settings
  for insert to authenticated with check (false);
create policy model_settings_update on private.model_settings
  for update to authenticated using (false) with check (false);
create policy model_settings_delete on private.model_settings
  for delete to authenticated using (false);

create policy usage_select on private.usage
  for select to authenticated using (false);
create policy usage_insert on private.usage
  for insert to authenticated with check (false);
create policy usage_update on private.usage
  for update to authenticated using (false) with check (false);
create policy usage_delete on private.usage
  for delete to authenticated using (false);

-- Reserve before every model operation ------------------------------------------------
-- One transaction-scoped advisory lock serializes all reservations, so concurrent calls
-- cannot pass the per-user or the global check together. The day starts at midnight
-- Europe/Berlin. Reserved and failed rows count: a crashed call keeps its reservation
-- until the day ends (fail closed).
create function public.reserve_model_call(
  p_user_id uuid,
  p_is_anonymous boolean,
  p_notebook_id uuid,
  p_kind text,
  p_model_id text,
  p_estimated_cost_usd numeric,
  p_call_count integer
) returns table (outcome text, usage_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  settings private.model_settings%rowtype;
  day_start timestamptz := date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
  user_limit numeric;
  user_spent numeric;
  global_spent numeric;
  new_id uuid;
begin
  if p_user_id is null then
    raise exception 'reserve_model_call: user is required' using errcode = '22023';
  end if;
  -- Rounded like the column, so a tiny estimate cannot be stored as 0.
  if p_estimated_cost_usd is null or round(p_estimated_cost_usd, 12) <= 0 then
    raise exception 'reserve_model_call: estimate must be positive' using errcode = '22023';
  end if;
  if p_call_count is null or p_call_count < 1 then
    raise exception 'reserve_model_call: call_count must be at least 1' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('embedding', 'chat') then
    raise exception 'reserve_model_call: unknown kind' using errcode = '22023';
  end if;
  if p_model_id is null or char_length(p_model_id) not between 1 and 200 then
    raise exception 'reserve_model_call: model id must be 1 to 200 characters' using errcode = '22023';
  end if;

  -- The lock only serializes the sums if each sum sees the commits made before it.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'reserve_model_call: needs read committed' using errcode = '25001';
  end if;

  select * into settings from private.model_settings where id;
  if not found or not settings.model_features_enabled then
    return query select 'kill_switch_on'::text, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('private.usage:reserve', 0));

  user_limit := case when coalesce(p_is_anonymous, true)
    then settings.daily_limit_anonymous_usd else settings.daily_limit_usd end;

  select coalesce(sum(u.cost_usd), 0) into user_spent
    from private.usage u
   where u.user_id = p_user_id and u.created_at >= day_start;
  if user_spent + p_estimated_cost_usd > user_limit then
    return query select 'budget_exceeded'::text, null::uuid;
    return;
  end if;

  select coalesce(sum(u.cost_usd), 0) into global_spent
    from private.usage u
   where u.created_at >= day_start;
  if global_spent + p_estimated_cost_usd > settings.global_daily_limit_usd then
    return query select 'global_budget_exceeded'::text, null::uuid;
    return;
  end if;

  insert into private.usage (user_id, notebook_id, kind, model_id, call_count, cost_usd)
  values (p_user_id, p_notebook_id, p_kind, p_model_id, p_call_count, p_estimated_cost_usd)
  returning id into new_id;

  return query select 'ok'::text, new_id;
end;
$$;

-- Settle after the model operation: replaces the estimate with the actual cost. Only a
-- reserved row changes, so a second settle is a no-op and returns false.
create function public.settle_model_call(
  p_usage_id uuid,
  p_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_usd numeric,
  p_latency_ms integer,
  p_message_id uuid,
  p_error_category text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('settled', 'failed') then
    raise exception 'settle_model_call: status must be settled or failed' using errcode = '22023';
  end if;

  update private.usage
     set status = p_status,
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         cost_usd = p_cost_usd,
         latency_ms = p_latency_ms,
         message_id = p_message_id,
         error_category = p_error_category,
         settled_at = now()
   where id = p_usage_id and status = 'reserved';
  return found;
end;
$$;

revoke execute on function public.reserve_model_call(uuid, boolean, uuid, text, text, numeric, integer)
  from public, anon, authenticated;
revoke execute on function public.settle_model_call(uuid, text, integer, integer, numeric, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reserve_model_call(uuid, boolean, uuid, text, text, numeric, integer)
  to service_role;
grant execute on function public.settle_model_call(uuid, text, integer, integer, numeric, integer, uuid, text)
  to service_role;

-- Only settle moves a row on: reserved to settled or failed, once. Updates that change
-- none of the settle columns pass, so on delete set null still clears the references.
create function private.usage_settle_only() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (new.status, new.input_tokens, new.output_tokens, new.cost_usd, new.latency_ms,
      new.error_category, new.settled_at)
     is not distinct from
     (old.status, old.input_tokens, old.output_tokens, old.cost_usd, old.latency_ms,
      old.error_category, old.settled_at) then
    -- After settle a message link may only be cleared, as on delete set null does.
    if old.status <> 'reserved' and new.message_id is not null
       and new.message_id is distinct from old.message_id then
      raise exception 'private.usage: a settled row keeps its message' using errcode = '55000';
    end if;
    return new;
  end if;
  if old.status <> 'reserved' or new.status not in ('settled', 'failed') then
    raise exception 'private.usage: only a reserved row can be settled' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke execute on function private.usage_settle_only() from public, anon, authenticated;

create trigger usage_settle_only
  before update on private.usage
  for each row execute function private.usage_settle_only();
