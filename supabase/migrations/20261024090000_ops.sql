-- Ops page (ADR 0023). Aggregates across all users for the operator page: ingestion failures
-- by category, cost per day, p95 latency, call status counts, today's global spend, the kill
-- switch and limits, and the latest live eval score. Counts and sums only: no user, notebook,
-- model, title or any text. Both functions are security invoker and executable only by
-- service_role; the app reaches them through lib/server/admin/ops.ts (ADR 0006 pattern).
-- Expand only.

create table private.eval_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  commit_sha text,
  security_passed integer not null,
  security_total integer not null,
  quality_passed integer not null,
  quality_total integer not null,
  errored integer not null,
  ok boolean not null
);

alter table private.eval_runs enable row level security;
create policy eval_runs_select on private.eval_runs for select to authenticated using (false);
create policy eval_runs_insert on private.eval_runs for insert to authenticated with check (false);
create policy eval_runs_update on private.eval_runs for update to authenticated using (false) with check (false);
create policy eval_runs_delete on private.eval_runs for delete to authenticated using (false);

revoke all on private.eval_runs from public, anon, authenticated, service_role;
grant select on private.eval_runs to service_role;
grant insert (commit_sha, security_passed, security_total, quality_passed, quality_total, errored, ok)
  on private.eval_runs to service_role;

-- Written by /api/eval after each live eval run (develop only, ADR 0017).
create function public.record_eval_run(
  p_commit_sha text,
  p_security_passed integer,
  p_security_total integer,
  p_quality_passed integer,
  p_quality_total integer,
  p_errored integer,
  p_ok boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_security_passed is null or p_security_total is null or p_quality_passed is null
     or p_quality_total is null or p_errored is null or p_ok is null
     or p_security_passed < 0 or p_security_total < 0 or p_security_passed > p_security_total
     or p_quality_passed < 0 or p_quality_total < 0 or p_quality_passed > p_quality_total
     or p_errored < 0
     or (p_commit_sha is not null and p_commit_sha !~ '^[0-9a-f]{7,40}$') then
    raise exception 'invalid eval run' using errcode = '22023';
  end if;
  insert into private.eval_runs (commit_sha, security_passed, security_total, quality_passed, quality_total, errored, ok)
  values (p_commit_sha, p_security_passed, p_security_total, p_quality_passed, p_quality_total, p_errored, p_ok);
end;
$$;

-- The window is the last p_days Berlin days including today; costs count every row, like the
-- budget (reserved and failed calls keep their cost).
create function public.ops_summary(p_days integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_from timestamptz;
  v_midnight timestamptz := v_today::timestamp at time zone 'Europe/Berlin';
begin
  if p_days is null or p_days not in (7, 30) then
    raise exception 'p_days must be 7 or 30' using errcode = '22023';
  end if;
  v_from := (v_today - (p_days - 1))::timestamp at time zone 'Europe/Berlin';

  return jsonb_build_object(
    'days', p_days,
    'ingest_errors', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'count', n) order by category)
      from (
        select coalesce(s.error_category, 'unknown') as category, count(*) as n
        from public.sources s
        where s.status = 'failed' and s.status_changed_at >= v_from
        group by 1
      ) e
    ), '[]'::jsonb),
    'cost_per_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', to_char(day, 'YYYY-MM-DD'), 'kind', kind, 'cost_usd', cost)
                       order by day, kind)
      from (
        select (u.created_at at time zone 'Europe/Berlin')::date as day, u.kind::text as kind,
               coalesce(sum(u.cost_usd), 0) as cost
        from private.usage u
        where u.created_at >= v_from
        group by 1, 2
      ) c
    ), '[]'::jsonb),
    'latency_p95', coalesce((
      select jsonb_agg(jsonb_build_object('kind', kind, 'p95_ms', p95) order by kind)
      from (
        select u.kind::text as kind, percentile_cont(0.95) within group (order by u.latency_ms) as p95
        from private.usage u
        where u.status = 'settled' and u.latency_ms is not null and u.created_at >= v_from
        group by 1
      ) l
    ), '[]'::jsonb),
    'status_counts', coalesce((
      select jsonb_agg(jsonb_build_object('kind', kind, 'status', status, 'count', n) order by kind, status)
      from (
        select u.kind::text as kind, u.status::text as status, count(*) as n
        from private.usage u
        where u.created_at >= v_from
        group by 1, 2
      ) s
    ), '[]'::jsonb),
    'global_today', (
      select jsonb_build_object(
        'spent_usd', coalesce((select sum(u.cost_usd) from private.usage u where u.created_at >= v_midnight), 0),
        'limit_usd', m.global_daily_limit_usd)
      from private.model_settings m
      where m.id
    ),
    'settings', (
      select jsonb_build_object(
        'model_features_enabled', m.model_features_enabled,
        'daily_limit_usd', m.daily_limit_usd,
        'daily_limit_anonymous_usd', m.daily_limit_anonymous_usd,
        'global_daily_limit_usd', m.global_daily_limit_usd)
      from private.model_settings m
      where m.id
    ),
    'eval', (
      select jsonb_build_object(
        'ran_at', r.ran_at, 'commit_sha', r.commit_sha,
        'security_passed', r.security_passed, 'security_total', r.security_total,
        'quality_passed', r.quality_passed, 'quality_total', r.quality_total,
        'errored', r.errored, 'ok', r.ok)
      from private.eval_runs r
      order by r.ran_at desc, r.id desc
      limit 1
    )
  );
end;
$$;

revoke execute on function public.record_eval_run(text, integer, integer, integer, integer, integer, boolean)
  from public, anon, authenticated;
revoke execute on function public.ops_summary(integer) from public, anon, authenticated;
grant execute on function public.record_eval_run(text, integer, integer, integer, integer, integer, boolean)
  to service_role;
grant execute on function public.ops_summary(integer) to service_role;
