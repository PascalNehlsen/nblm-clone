-- Ops page (database part): private.eval_runs, public.record_eval_run and public.ops_summary.
--
-- Contract pinned here (migration supabase/migrations/20261024090000_ops.sql, expand-only):
--
--   private.eval_runs   id (identity), ran_at timestamptz, commit_sha text, security_passed,
--                       security_total, quality_passed, quality_total, errored (integers), ok boolean.
--                       RLS on, four deny-all policies for authenticated, nothing for PUBLIC, anon or
--                       authenticated, service_role: select + insert of the seven data columns only.
--   public.record_eval_run(p_commit_sha text, p_security_passed int, p_security_total int,
--                          p_quality_passed int, p_quality_total int, p_errored int, p_ok boolean)
--                       returns void. Security invoker, search_path '', service_role only. Raises 22023
--                       unless 0 <= passed <= total (both families) and errored >= 0.
--   public.ops_summary(p_days int) returns jsonb. Security invoker, stable, search_path '',
--                       service_role only. Raises 22023 unless p_days is 7 or 30 (null included).
--                       Keys: days, ingest_errors, cost_per_day, latency_p95, status_counts,
--                       global_today, settings, eval. Every time series follows the window. Days are
--                       Europe/Berlin days. A failed source without a category is reported as 'unknown'.
--                       The output holds no user id, notebook id, model id or title.
--   latency_p95 is percentile_cont(0.95) over settled rows only (not failed, not reserved).
--   eval is the row with the greatest ran_at (not the greatest id), without id, or JSON null.
--
-- The summary is read as service_role (set local role), the only role that may run it, so the
-- grants it needs are proven too. All data lives in this transaction and is rolled back. The
-- aggregates cover whole tables, so the file clears usage, sources and eval_runs inside the
-- transaction first. Fixture times are computed from Berlin midnight, so the day split holds in
-- CET and CEST alike. Every call goes through a dynamic probe, so a missing object is a clean
-- pgTAP failure instead of an aborted script.
--
-- Red before the migration: private.eval_runs and both functions do not exist.

begin;

select plan(109);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.safe_ok(probe text, description text) returns text as $$
declare
  result boolean;
begin
  begin
    execute probe into result;
  exception when others then
    result := false;
  end;
  return ok(coalesce(result, false), description);
end;
$$ language plpgsql;

create function pg_temp.sql_lives(probe text, description text) returns text as $$
declare
  ok_flag boolean := true;
  err_text text := '';
begin
  begin
    execute probe;
  exception when others then
    ok_flag := false;
    get stacked diagnostics err_text = message_text;
  end;
  if ok_flag then
    return ok(true, description);
  else
    return ok(false, description || ' [errored: ' || err_text || ']');
  end if;
end;
$$ language plpgsql;

create function pg_temp.act_lives(actor_id uuid, probe text, description text) returns text as $$
declare
  ok_flag boolean := true;
  err_text text := '';
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated', 'is_anonymous', false)::text,
    true
  );
  begin
    execute probe;
  exception when others then
    ok_flag := false;
    get stacked diagnostics err_text = message_text;
  end;
  reset role;
  if ok_flag then
    return ok(true, description);
  else
    return ok(false, description || ' [errored: ' || err_text || ']');
  end if;
end;
$$ language plpgsql;

-- Runs a probe as anon or authenticated and compares the SQLSTATE.
create function pg_temp.role_throws(role_name text, probe text, expected_sqlstate text, description text)
returns text as $$
declare
  actual_sqlstate text := null;
begin
  execute format('set local role %I', role_name);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', role_name, 'is_anonymous', false)::text,
    true
  );
  begin
    execute probe;
  exception when others then
    get stacked diagnostics actual_sqlstate = returned_sqlstate;
  end;
  reset role;
  return is(actual_sqlstate, expected_sqlstate, description);
end;
$$ language plpgsql;

-- 'OK' when the statement ran as service_role, otherwise the SQLSTATE.
create function pg_temp.svc_sqlstate(probe text) returns text as $$
declare
  state text := 'OK';
begin
  set local role service_role;
  begin
    execute probe;
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
  end;
  reset role;
  return state;
end;
$$ language plpgsql;

-- ops_summary(p_days) as service_role; null when it fails.
create function pg_temp.svc_summary(p_days int) returns jsonb as $$
declare
  r jsonb;
begin
  set local role service_role;
  begin
    execute 'select public.ops_summary($1)' into r using p_days;
  exception when others then
    r := null;
  end;
  reset role;
  return r;
end;
$$ language plpgsql;

create function pg_temp.has_deny_policy(cmd text) returns boolean as $$
  select exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'eval_runs'
      and p.polcmd = cmd
      and p.polpermissive
      and (
        (cmd in ('r', 'd') and coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false')
        or (cmd = 'a' and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') = 'false')
        or (cmd = 'w'
            and coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false'
            and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') = 'false')
      )
  );
$$ language sql;

create function pg_temp.no_privilege_at_all(role_name text) returns boolean as $$
  select not (
    coalesce(has_table_privilege(role_name, to_regclass('private.eval_runs'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'), false)
    or coalesce(has_any_column_privilege(role_name, to_regclass('private.eval_runs'), 'SELECT,INSERT,UPDATE,REFERENCES'), false)
  );
$$ language sql;

create function pg_temp.fn_oid(signature text) returns oid as $$
  select to_regprocedure(signature);
$$ language sql;

-- Exists, security invoker, exact empty search_path.
create function pg_temp.fn_shape_ok(signature text) returns boolean as $$
  select coalesce(
    (select not p.prosecdef and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = pg_temp.fn_oid(signature)),
    false
  );
$$ language sql;

create function pg_temp.fn_not_exec_for_api_roles(signature text) returns boolean as $$
  select pg_temp.fn_oid(signature) is not null
    and not has_function_privilege('public', pg_temp.fn_oid(signature), 'EXECUTE')
    and not has_function_privilege('anon', pg_temp.fn_oid(signature), 'EXECUTE')
    and not has_function_privilege('authenticated', pg_temp.fn_oid(signature), 'EXECUTE');
$$ language sql;

create function pg_temp.keys(j jsonb) returns text[] as $$
  select coalesce(array_agg(k order by k collate "C"), '{}') from jsonb_object_keys(j) as k;
$$ language sql;

-- Snapshots of the summary, taken once and read many times.
create table pg_temp.res (label text primary key, j jsonb);
create table pg_temp.ids (user_id uuid not null, nb uuid not null, mid timestamptz not null,
  prev_day text not null, cur_day text not null, chat_day text not null, old_day text not null);

create function pg_temp.snap(label text) returns jsonb as $$
  select r.j from pg_temp.res r where r.label = $1;
$$ language sql;

create function pg_temp.cost(label text, day text, kind text) returns numeric as $$
  select sum((e->>'cost_usd')::numeric)
  from jsonb_array_elements(pg_temp.snap(label)->'cost_per_day') e
  where e->>'day' = day and e->>'kind' = kind;
$$ language sql;

create function pg_temp.p95(label text, kind text) returns numeric as $$
  select max((e->>'p95_ms')::numeric)
  from jsonb_array_elements(pg_temp.snap(label)->'latency_p95') e
  where e->>'kind' = kind;
$$ language sql;

create function pg_temp.status_n(label text, kind text, status text) returns numeric as $$
  select sum((e->>'count')::numeric)
  from jsonb_array_elements(pg_temp.snap(label)->'status_counts') e
  where e->>'kind' = kind and e->>'status' = status;
$$ language sql;

create function pg_temp.ingest_n(label text, category text) returns numeric as $$
  select sum((e->>'count')::numeric)
  from jsonb_array_elements(pg_temp.snap(label)->'ingest_errors') e
  where e->>'category' = category;
$$ language sql;

-- ---------------------------------------------------------------------------
-- A) private.eval_runs: shape, RLS, grants (21)
-- ---------------------------------------------------------------------------

select ok(to_regclass('private.eval_runs') is not null, 'private.eval_runs exists');
select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'private' and c.relname = 'eval_runs'), false),
  'RLS is enabled on private.eval_runs'
);
select is_empty(
  $sql$
    select p.polname from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'eval_runs' and p.polcmd = '*'
  $sql$,
  'no FOR ALL policy exists on private.eval_runs'
);
select ok(pg_temp.has_deny_policy('r'), 'private.eval_runs has a deny-all select policy (using (false))');
select ok(pg_temp.has_deny_policy('a'), 'private.eval_runs has a deny-all insert policy (with check (false))');
select ok(pg_temp.has_deny_policy('w'), 'private.eval_runs has a deny-all update policy (using/with check (false))');
select ok(pg_temp.has_deny_policy('d'), 'private.eval_runs has a deny-all delete policy (using (false))');

select columns_are('private', 'eval_runs', array[
  'id', 'ran_at', 'commit_sha', 'security_passed', 'security_total',
  'quality_passed', 'quality_total', 'errored', 'ok'
]);
select col_type_is('private', 'eval_runs', 'ran_at', 'timestamp with time zone', 'ran_at is timestamptz');
select col_type_is('private', 'eval_runs', 'ok', 'boolean', 'ok is boolean');
select col_type_is('private', 'eval_runs', 'commit_sha', 'text', 'commit_sha is text');
select pg_temp.safe_ok(
  $sql$
    select a.attidentity <> ''
    from pg_attribute a
    where a.attrelid = to_regclass('private.eval_runs') and a.attname = 'id' and not a.attisdropped
  $sql$,
  'eval_runs.id is an identity column'
);

select ok(pg_temp.no_privilege_at_all('public'), 'PUBLIC has no privilege on private.eval_runs');
select ok(pg_temp.no_privilege_at_all('anon'), 'anon has no privilege on private.eval_runs');
select ok(pg_temp.no_privilege_at_all('authenticated'), 'authenticated has no privilege on private.eval_runs');

select ok(
  coalesce(has_table_privilege('service_role', to_regclass('private.eval_runs'), 'SELECT'), false),
  'service_role has SELECT on private.eval_runs'
);
select ok(
  coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'commit_sha', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'security_passed', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'security_total', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'quality_passed', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'quality_total', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'errored', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'ok', 'INSERT'), false),
  'service_role can insert commit_sha, security_passed, security_total, quality_passed, quality_total, errored and ok'
);
select ok(
  to_regclass('private.eval_runs') is not null
  and not coalesce(has_column_privilege('service_role', to_regclass('private.eval_runs'), 'id', 'INSERT'), false),
  'service_role cannot insert the id column'
);
select ok(
  to_regclass('private.eval_runs') is not null
  and not coalesce(has_table_privilege('service_role', to_regclass('private.eval_runs'), 'UPDATE'), false)
  and not coalesce(has_any_column_privilege('service_role', to_regclass('private.eval_runs'), 'UPDATE'), false)
  and not coalesce(has_table_privilege('service_role', to_regclass('private.eval_runs'), 'DELETE'), false)
  and not coalesce(has_table_privilege('service_role', to_regclass('private.eval_runs'), 'TRUNCATE'), false),
  'service_role cannot update, delete or truncate private.eval_runs'
);

select pg_temp.role_throws('authenticated', 'select * from private.eval_runs', '42501',
  'authenticated cannot read private.eval_runs (42501)');
select pg_temp.role_throws('anon', 'select * from private.eval_runs', '42501',
  'anon cannot read private.eval_runs (42501)');

-- ---------------------------------------------------------------------------
-- B) The two functions: shape and lockdown (14)
-- ---------------------------------------------------------------------------

select ok(pg_temp.fn_oid('public.ops_summary(integer)') is not null, 'public.ops_summary(integer) exists');
select ok(pg_temp.fn_shape_ok('public.ops_summary(integer)'),
  'ops_summary is security invoker and sets exactly search_path = ""');
select ok(pg_temp.fn_not_exec_for_api_roles('public.ops_summary(integer)'),
  'ops_summary is not executable by PUBLIC, anon or authenticated');
select ok(coalesce(has_function_privilege('service_role', pg_temp.fn_oid('public.ops_summary(integer)'), 'EXECUTE'), false),
  'service_role can execute ops_summary');
select ok(
  coalesce((select p.prorettype = 'jsonb'::regtype and p.provolatile = 's'
            from pg_proc p where p.oid = pg_temp.fn_oid('public.ops_summary(integer)')), false),
  'ops_summary returns jsonb and is stable'
);

select ok(pg_temp.fn_oid('public.record_eval_run(text,integer,integer,integer,integer,integer,boolean)') is not null,
  'public.record_eval_run(text,integer,integer,integer,integer,integer,boolean) exists');
select ok(pg_temp.fn_shape_ok('public.record_eval_run(text,integer,integer,integer,integer,integer,boolean)'),
  'record_eval_run is security invoker and sets exactly search_path = ""');
select ok(pg_temp.fn_not_exec_for_api_roles('public.record_eval_run(text,integer,integer,integer,integer,integer,boolean)'),
  'record_eval_run is not executable by PUBLIC, anon or authenticated');
select ok(
  coalesce(has_function_privilege('service_role',
    pg_temp.fn_oid('public.record_eval_run(text,integer,integer,integer,integer,integer,boolean)'), 'EXECUTE'), false),
  'service_role can execute record_eval_run'
);
select ok(
  coalesce((select p.prorettype = 'void'::regtype
            from pg_proc p where p.oid = pg_temp.fn_oid('public.record_eval_run(text,integer,integer,integer,integer,integer,boolean)')), false),
  'record_eval_run returns void'
);

select pg_temp.role_throws('authenticated', 'select public.ops_summary(7)', '42501',
  'authenticated cannot call ops_summary (42501)');
select pg_temp.role_throws('anon', 'select public.ops_summary(7)', '42501',
  'anon cannot call ops_summary (42501)');
select pg_temp.role_throws('authenticated', $sql$ select public.record_eval_run('abc1234', 1, 2, 1, 2, 0, true) $sql$, '42501',
  'authenticated cannot call record_eval_run (42501)');
select pg_temp.role_throws('anon', $sql$ select public.record_eval_run('abc1234', 1, 2, 1, 2, 0, true) $sql$, '42501',
  'anon cannot call record_eval_run (42501)');

-- ---------------------------------------------------------------------------
-- C) Validation and recording (20)
-- ---------------------------------------------------------------------------

select is(pg_temp.svc_sqlstate('select public.ops_summary(0)'), '22023', 'ops_summary(0) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(1)'), '22023', 'ops_summary(1) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(8)'), '22023', 'ops_summary(8) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(14)'), '22023', 'ops_summary(14) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(31)'), '22023', 'ops_summary(31) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(-7)'), '22023', 'ops_summary(-7) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(null::int)'), '22023', 'ops_summary(null) raises 22023');
select is(pg_temp.svc_sqlstate('select public.ops_summary(7)'), 'OK', 'ops_summary(7) runs as service_role');
select is(pg_temp.svc_sqlstate('select public.ops_summary(30)'), 'OK', 'ops_summary(30) runs as service_role');

select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('badbad1', -1, 5, 1, 2, 0, true) $sql$), '22023',
  'record_eval_run rejects a negative security_passed (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('badbad2', 6, 5, 1, 2, 0, true) $sql$), '22023',
  'record_eval_run rejects security_passed above security_total (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('badbad3', 1, 5, 3, 2, 0, true) $sql$), '22023',
  'record_eval_run rejects quality_passed above quality_total (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('badbad4', 0, -1, 0, 2, 0, true) $sql$), '22023',
  'record_eval_run rejects a negative total (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('badbad5', 1, 5, 1, 2, -1, true) $sql$), '22023',
  'record_eval_run rejects a negative errored count (22023)');
select pg_temp.safe_ok(
  $sql$ select count(*) = 0 from private.eval_runs where commit_sha like 'badbad%' $sql$,
  'rejected record_eval_run calls stored nothing'
);

select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('a000001', 0, 0, 0, 0, 0, false) $sql$), 'OK',
  'record_eval_run accepts all zeros');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('a000002', 5, 5, 12, 12, 0, true) $sql$), 'OK',
  'record_eval_run accepts passed equal to total');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run(null, 5, 5, 12, 12, 0, true) $sql$), 'OK',
  'record_eval_run accepts a null commit sha');

-- Commit sha format: null, or lowercase hex of 7 to 40 characters (^[0-9a-f]{7,40}$), else 22023.
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('not-a-sha', 5, 5, 12, 12, 0, true) $sql$), '22023',
  'record_eval_run rejects a commit sha that is not hex (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('ABC1234', 5, 5, 12, 12, 0, true) $sql$), '22023',
  'record_eval_run rejects an uppercase commit sha (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run(repeat('a', 41), 5, 5, 12, 12, 0, true) $sql$), '22023',
  'record_eval_run rejects a 41-character commit sha (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('abc123', 5, 5, 12, 12, 0, true) $sql$), '22023',
  'record_eval_run rejects a 6-character commit sha (22023)');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run('abc1234', 5, 5, 12, 12, 0, true) $sql$), 'OK',
  'record_eval_run accepts a 7-character hex commit sha');
select is(pg_temp.svc_sqlstate($sql$ select public.record_eval_run(repeat('a', 40), 5, 5, 12, 12, 0, true) $sql$), 'OK',
  'record_eval_run accepts a 40-character hex commit sha');
select pg_temp.safe_ok(
  $sql$ select count(*) = 0 from private.eval_runs where commit_sha in ('not-a-sha', 'ABC1234', 'abc123') or length(commit_sha) > 40 $sql$,
  'rejected commit shas stored nothing'
);

select is(
  pg_temp.svc_sqlstate($sql$ select public.record_eval_run('c0ffee1', 3, 4, 6, 10, 1, false) $sql$),
  'OK',
  'setup: service_role records one eval run'
);
select pg_temp.safe_ok(
  $sql$
    select count(*) = 1 from private.eval_runs
    where commit_sha = 'c0ffee1'
      and security_passed = 3 and security_total = 4
      and quality_passed = 6 and quality_total = 10
      and errored = 1 and ok = false
      and ran_at is not null and ran_at <= now() + interval '1 minute'
  $sql$,
  'record_eval_run stores exactly the given values and stamps ran_at'
);

-- ---------------------------------------------------------------------------
-- D) ops_summary behaviour (47)
-- ---------------------------------------------------------------------------

-- Clear what other files may have committed: the aggregates read whole tables.
select pg_temp.sql_lives('delete from private.usage', 'setup: clear private.usage inside the transaction');
select pg_temp.sql_lives('delete from public.sources', 'setup: clear public.sources inside the transaction');
select pg_temp.sql_lives('delete from private.eval_runs', 'setup: clear private.eval_runs inside the transaction');

insert into pg_temp.res values ('empty', pg_temp.svc_summary(7));

select pg_temp.safe_ok(
  $sql$ select pg_temp.snap('empty') -> 'eval' = 'null'::jsonb $sql$,
  'with no eval run, eval is JSON null'
);
select pg_temp.safe_ok(
  $sql$
    select jsonb_typeof(j->'ingest_errors') = 'array' and jsonb_typeof(j->'cost_per_day') = 'array'
       and jsonb_typeof(j->'latency_p95') = 'array' and jsonb_typeof(j->'status_counts') = 'array'
       and jsonb_array_length(j->'ingest_errors') = 0 and jsonb_array_length(j->'latency_p95') = 0
       and jsonb_array_length(j->'status_counts') = 0
    from (select pg_temp.snap('empty') as j) s
  $sql$,
  'with no data, the series are empty arrays and never null'
);
select pg_temp.safe_ok(
  $sql$
    select (j->'global_today'->>'spent_usd')::numeric = 0 and (j->'global_today'->>'limit_usd') is not null
    from (select pg_temp.snap('empty') as j) s
  $sql$,
  'with no usage, global_today.spent_usd is 0 and the limit is present'
);

-- Fixture: one user and notebook, times relative to Berlin midnight two days ago.
create table pg_temp.uid (id uuid not null default gen_random_uuid());
insert into pg_temp.uid default values;

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data)
select id, 'ops-' || id::text || '@example.test', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb
from pg_temp.uid;

insert into pg_temp.ids
select u.id,
       gen_random_uuid(),
       m.mid,
       to_char(m.d - 1, 'YYYY-MM-DD'),
       to_char(m.d, 'YYYY-MM-DD'),
       to_char(((now() - interval '3 days') at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD'),
       to_char(((now() - interval '10 days') at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD')
from pg_temp.uid u
cross join (
  select d, (d::timestamp at time zone 'Europe/Berlin') as mid
  from (select ((now() at time zone 'Europe/Berlin')::date - 2) as d) x
) m;

select pg_temp.act_lives(
  (select user_id from pg_temp.ids),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select nb from pg_temp.ids), 'pgtap ops'),
  'setup: the user creates a notebook'
);

select pg_temp.sql_lives(
  $sql$
    update private.model_settings
       set model_features_enabled = true, daily_limit_usd = 0.5, daily_limit_anonymous_usd = 0.2,
           global_daily_limit_usd = 7.5
     where id = true
  $sql$,
  'setup: known model settings'
);

select pg_temp.sql_lives(
  $sql$
    insert into public.sources (notebook_id, kind, title, status, error_category, status_changed_at)
    select i.nb, 'text', 'pgtap-title-secret', v.status, v.category, v.changed_at
    from pg_temp.ids i
    cross join (values
      ('failed', 'zz_in_window', now() - interval '3 days'),
      ('failed', 'zz_in_window', now() - interval '3 days'),
      ('failed', 'zz_old', now() - interval '10 days'),
      ('failed', 'zz_ancient', now() - interval '40 days'),
      ('failed', null, now() - interval '1 day'),
      ('processing', null, now()),
      ('ready', null, now())
    ) as v(status, category, changed_at)
  $sql$,
  'setup: failed sources in, near and outside the windows, plus a processing and a ready one'
);

select pg_temp.sql_lives(
  $sql$
    insert into private.usage (user_id, notebook_id, kind, model_id, status, call_count, input_tokens,
                               output_tokens, cost_usd, latency_ms, created_at, settled_at)
    select i.user_id, i.nb, 'chat', 'pgtap-model-secret', 'settled', 1, 10, 10, 0.01, g * 100,
           now() - interval '3 days', now() - interval '3 days'
    from pg_temp.ids i cross join generate_series(1, 20) as g
  $sql$,
  'setup: 20 settled chat rows with latencies 100 to 2000 ms'
);

select pg_temp.sql_lives(
  $sql$
    insert into private.usage (user_id, notebook_id, kind, model_id, status, call_count, input_tokens,
                               output_tokens, cost_usd, latency_ms, error_category, created_at, settled_at)
    select i.user_id, i.nb, v.kind, 'pgtap-model-secret', v.status, 1,
           case when v.status = 'reserved' then null else 10 end,
           case when v.status = 'reserved' then null else 10 end,
           v.cost, v.latency, v.category, v.at,
           case when v.status = 'reserved' then null else v.at end
    from pg_temp.ids i
    cross join lateral (values
      ('embedding', 'settled', 0.10, 50, null, i.mid - interval '1 minute'),
      ('embedding', 'settled', 0.20, 50, null, i.mid + interval '1 minute'),
      ('embedding', 'settled', 1.25, 50, null, now()),
      ('chat', 'settled', 1.00, 50000, null, now() - interval '10 days'),
      ('chat', 'failed', 0.30, 99999, 'provider_timeout', now() - interval '1 day'),
      ('chat', 'reserved', 0.40, null, null, now() - interval '1 day')
    ) as v(kind, status, cost, latency, category, at)
  $sql$,
  'setup: Berlin midnight split rows, today row, an old row, a failed and a reserved row'
);

select pg_temp.sql_lives(
  $sql$
    insert into private.eval_runs (ran_at, commit_sha, security_passed, security_total, quality_passed,
                                   quality_total, errored, ok)
    values (now() - interval '1 day', 'e0000001', 5, 5, 9, 12, 1, true),
           (now() - interval '2 days', 'e0000002', 1, 5, 2, 12, 0, false)
  $sql$,
  'setup: two eval runs, the newer one inserted first'
);

insert into pg_temp.res values ('s7', pg_temp.svc_summary(7));
insert into pg_temp.res values ('s30', pg_temp.svc_summary(30));

-- Top level
select pg_temp.safe_ok(
  $sql$
    select pg_temp.keys(pg_temp.snap('s7')) = array['cost_per_day', 'days', 'eval', 'global_today',
      'ingest_errors', 'latency_p95', 'settings', 'status_counts']
  $sql$,
  'the summary has exactly the keys days, ingest_errors, cost_per_day, latency_p95, status_counts, global_today, settings, eval'
);
select pg_temp.safe_ok($sql$ select pg_temp.snap('s7') -> 'days' = '7'::jsonb $sql$, 'ops_summary(7) reports days = 7');
select pg_temp.safe_ok($sql$ select pg_temp.snap('s30') -> 'days' = '30'::jsonb $sql$, 'ops_summary(30) reports days = 30');

-- Settings and global_today
select pg_temp.safe_ok(
  $sql$
    select pg_temp.keys(pg_temp.snap('s7') -> 'settings') = array['daily_limit_anonymous_usd', 'daily_limit_usd',
      'global_daily_limit_usd', 'model_features_enabled']
  $sql$,
  'settings has exactly the kill switch and the three limits (no updated_by, no reason)'
);
select pg_temp.safe_ok(
  $sql$
    select (j->'settings'->'model_features_enabled') = 'true'::jsonb
       and (j->'settings'->>'daily_limit_usd')::numeric = 0.5
       and (j->'settings'->>'daily_limit_anonymous_usd')::numeric = 0.2
       and (j->'settings'->>'global_daily_limit_usd')::numeric = 7.5
    from (select pg_temp.snap('s7') as j) s
  $sql$,
  'settings carries the current values from private.model_settings'
);
select pg_temp.safe_ok(
  $sql$ select pg_temp.keys(pg_temp.snap('s7') -> 'global_today') = array['limit_usd', 'spent_usd'] $sql$,
  'global_today has exactly spent_usd and limit_usd'
);
select pg_temp.safe_ok(
  $sql$
    select (j->'global_today'->>'limit_usd')::numeric = 7.5
       and abs((j->'global_today'->>'spent_usd')::numeric - 1.25) < 0.0001
    from (select pg_temp.snap('s7') as j) s
  $sql$,
  'global_today is the global limit and what was spent since Berlin midnight'
);

-- Eval
select pg_temp.safe_ok(
  $sql$
    select pg_temp.keys(pg_temp.snap('s7') -> 'eval') = array['commit_sha', 'errored', 'ok', 'quality_passed',
      'quality_total', 'ran_at', 'security_passed', 'security_total']
  $sql$,
  'eval has the eight columns of the run and no id'
);
select pg_temp.safe_ok(
  $sql$
    select j->'eval'->>'commit_sha' = 'e0000001'
       and (j->'eval'->>'security_passed')::int = 5 and (j->'eval'->>'security_total')::int = 5
       and (j->'eval'->>'quality_passed')::int = 9 and (j->'eval'->>'quality_total')::int = 12
       and (j->'eval'->>'errored')::int = 1 and j->'eval'->'ok' = 'true'::jsonb
    from (select pg_temp.snap('s7') as j) s
  $sql$,
  'eval is the run with the latest ran_at, not the highest id'
);

-- Ingest errors
select pg_temp.safe_ok($sql$ select pg_temp.ingest_n('s7', 'zz_in_window') = 2 $sql$,
  'ingest_errors counts the two failed sources of the window under their category');
select pg_temp.safe_ok($sql$ select pg_temp.ingest_n('s7', 'zz_old') is null $sql$,
  'a source that failed 10 days ago is not in the 7-day window');
select pg_temp.safe_ok($sql$ select pg_temp.ingest_n('s7', 'zz_ancient') is null and pg_temp.ingest_n('s30', 'zz_ancient') is null $sql$,
  'a source that failed 40 days ago is in neither window');
select pg_temp.safe_ok($sql$ select pg_temp.ingest_n('s30', 'zz_old') = 1 and pg_temp.ingest_n('s30', 'zz_in_window') = 2 $sql$,
  'the 30-day window includes the source that failed 10 days ago');
select pg_temp.safe_ok($sql$ select pg_temp.ingest_n('s7', 'unknown') = 1 $sql$,
  'a failed source without a category is reported as unknown');
select pg_temp.safe_ok(
  $sql$
    select coalesce(sum((e->>'count')::int), 0) = 3
    from jsonb_array_elements(pg_temp.snap('s7')->'ingest_errors') e
  $sql$,
  'processing and ready sources are not counted (3 failures in the 7-day window)'
);
select pg_temp.safe_ok(
  $sql$
    select count(*) > 0 and coalesce(bool_and(pg_temp.keys(e) = array['category', 'count']), false)
    from jsonb_array_elements(pg_temp.snap('s7')->'ingest_errors') e
  $sql$,
  'every ingest_errors entry has exactly category and count'
);
select pg_temp.safe_ok(
  $sql$
    select count(*) > 0 and bool_and(jsonb_typeof(e->'count') = 'number' and jsonb_typeof(e->'category') = 'string')
    from jsonb_array_elements(pg_temp.snap('s30')->'ingest_errors') e
  $sql$,
  'ingest_errors entries carry a string category and a numeric count'
);

-- Cost per day (Berlin days, windowed)
select pg_temp.safe_ok(
  $sql$
    select count(*) > 0 and coalesce(bool_and(pg_temp.keys(e) = array['cost_usd', 'day', 'kind']), false)
    from jsonb_array_elements(pg_temp.snap('s7')->'cost_per_day') e
  $sql$,
  'every cost_per_day entry has exactly day, kind and cost_usd'
);
select pg_temp.safe_ok(
  $sql$
    select count(*) > 0 and coalesce(bool_and((e->>'day') ~ '^\d{4}-\d{2}-\d{2}$' and e->>'kind' in ('embedding', 'chat')), false)
    from jsonb_array_elements(pg_temp.snap('s7')->'cost_per_day') e
  $sql$,
  'cost_per_day days are YYYY-MM-DD and kinds are embedding or chat'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.cost('s7', (select prev_day from pg_temp.ids), 'embedding') - 0.10) < 0.0001 $sql$,
  'a row one minute before Berlin midnight belongs to the previous Berlin day'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.cost('s7', (select cur_day from pg_temp.ids), 'embedding') - 0.20) < 0.0001 $sql$,
  'a row one minute after Berlin midnight belongs to the new Berlin day, not the UTC day'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.cost('s7', (select chat_day from pg_temp.ids), 'chat') - 0.20) < 0.0001 $sql$,
  'twenty settled chat rows of 0.01 add up to 0.20 on their day'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.cost('s7', to_char((now() at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD'), 'embedding') - 1.25) < 0.0001 $sql$,
  'today''s Berlin day carries today''s cost'
);
select pg_temp.safe_ok(
  $sql$ select pg_temp.cost('s7', (select old_day from pg_temp.ids), 'chat') is null $sql$,
  'a row from 10 days ago is not in the 7-day cost series'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.cost('s30', (select old_day from pg_temp.ids), 'chat') - 1.00) < 0.0001 $sql$,
  'the 30-day cost series includes the row from 10 days ago'
);

-- Latency p95: settled rows only, windowed
select pg_temp.safe_ok(
  $sql$
    select count(*) > 0 and coalesce(bool_and(pg_temp.keys(e) = array['kind', 'p95_ms']), false)
    from jsonb_array_elements(pg_temp.snap('s7')->'latency_p95') e
  $sql$,
  'every latency_p95 entry has exactly kind and p95_ms'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.p95('s7', 'chat') - 1905) < 0.01 $sql$,
  'chat p95 over 20 settled latencies 100..2000 is 1905 (percentile_cont, failed and reserved rows excluded)'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.p95('s7', 'embedding') - 50) < 0.01 $sql$,
  'embedding p95 over three 50 ms rows is 50'
);
select pg_temp.safe_ok(
  $sql$ select abs(pg_temp.p95('s30', 'chat') - 2000) < 0.01 $sql$,
  'the 30-day chat p95 includes the 10-day-old row (21 values, p95 is the 20th: 2000)'
);

-- Status counts
select pg_temp.safe_ok(
  $sql$
    select count(*) > 0 and coalesce(bool_and(pg_temp.keys(e) = array['count', 'kind', 'status']), false)
    from jsonb_array_elements(pg_temp.snap('s7')->'status_counts') e
  $sql$,
  'every status_counts entry has exactly kind, status and count'
);
select pg_temp.safe_ok($sql$ select pg_temp.status_n('s7', 'chat', 'settled') = 20 $sql$,
  '20 settled chat rows in the 7-day window');
select pg_temp.safe_ok($sql$ select pg_temp.status_n('s7', 'chat', 'failed') = 1 $sql$,
  '1 failed chat row in the 7-day window');
select pg_temp.safe_ok($sql$ select pg_temp.status_n('s7', 'embedding', 'settled') = 3 $sql$,
  '3 settled embedding rows in the 7-day window');
select pg_temp.safe_ok($sql$ select pg_temp.status_n('s30', 'chat', 'settled') = 21 $sql$,
  '21 settled chat rows in the 30-day window');

-- Nothing personal or textual in the output
select pg_temp.safe_ok(
  $sql$
    select not exists (
      select 1
      from pg_temp.res r
      cross join pg_temp.ids i
      cross join unnest(array[i.user_id::text, i.nb::text, 'pgtap-model-secret', 'pgtap-title-secret',
        'user_id', 'notebook_id', 'message_id', 'model_id', 'title']) as needle
      where r.label in ('s7', 's30') and position(needle in r.j::text) > 0
    )
  $sql$,
  'the output contains no user id, notebook id, model id, source title or id-shaped key'
);

select * from finish();

rollback;
