-- F1 (demo login, database part): the purge of expired anonymous users, the two
-- 90-day retention functions and the three pg_cron jobs.
--
--   private.purge_expired_demo_users()   returns integer, invoker, empty search_path
--   private.purge_old_membership_audit() returns integer, invoker, empty search_path
--   private.anonymize_old_usage()        returns integer, invoker, empty search_path
--   cron.job: nblm-purge-demo-users, nblm-membership-audit-retention,
--             nblm-usage-retention
--
-- The purge deletes at most 200 anonymous users per call (oldest first) whose
-- created_at is older than 24 hours, together with the notebooks they own as the
-- only owner (sources, chunks, messages, citations and members cascade), nulls
-- their ids in private.membership_audit, and never touches non-anonymous users,
-- younger anonymous users, notebooks with a remaining owner outside the batch, or
-- the template notebook.
--
-- All data is created inside the transaction and rolled back. The old users get a
-- created_at far in the past (6000 and 5000 days) so they sort before any other
-- stale row the local database might hold, which keeps the "oldest first, 200 per
-- batch" assertions deterministic. Functions and cron rows are reached through
-- dynamic probes so a missing object is a clean pgTAP FAIL.

begin;

select plan(55);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.proc_oid(schema_name text, proc_name text) returns oid as $$
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = schema_name and p.proname = proc_name
  limit 1;
$$ language sql;

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

-- One scalar as the current role; 'ERROR:<sqlstate>' on error.
create function pg_temp.sql_scalar(probe text) returns text as $$
declare
  result text;
  err_state text;
begin
  begin
    execute probe into result;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate;
    result := 'ERROR:' || err_state;
  end;
  return result;
end;
$$ language plpgsql;

create function pg_temp.act_lives(actor_id uuid, anon boolean, probe text, description text) returns text as $$
declare
  ok_flag boolean := true;
  err_text text := '';
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated', 'is_anonymous', anon)::text,
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

create function pg_temp.act_throws(actor_id uuid, anon boolean, probe text, expected_sqlstate text, description text)
returns text as $$
declare
  actual_sqlstate text := null;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated', 'is_anonymous', anon)::text,
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

-- Shape of a retention/purge function: exists, security invoker, returns
-- integer, exact empty search_path.
create function pg_temp.fn_shape_ok(fn text) returns boolean as $$
  select coalesce(
    (select not p.prosecdef
            and p.prorettype = 'int4'::regtype
            and 'search_path=""' = any(coalesce(p.proconfig, '{}'))
     from pg_proc p where p.oid = pg_temp.proc_oid('private', fn)),
    false
  );
$$ language sql;

-- Nobody but the owner can execute it: no grant for anon, authenticated or PUBLIC.
create function pg_temp.fn_locked_ok(fn text) returns boolean as $$
  select coalesce(
    (select p.proacl is not null
            and not has_function_privilege('anon', p.oid, 'EXECUTE')
            and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
            and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
     from pg_proc p where p.oid = pg_temp.proc_oid('private', fn)),
    false
  );
$$ language sql;

create function pg_temp.unit_vec(pos int) returns text as $$
  select '[' || string_agg(case when i = pos then '1' else '0' end, ',' order by i) || ']'
  from generate_series(1, 1024) as i;
$$ language sql;

create table pg_temp.fx (k text primary key, v uuid not null default gen_random_uuid());
insert into pg_temp.fx (k) values
  ('tmpl_owner'), ('tmpl_nb'), ('tmpl_src'),
  ('old_anon1'), ('old_anon2'), ('old_anon3'), ('young_anon'), ('old_reg'),
  ('nb_old1'), ('nb_old2'), ('nb_shared'), ('nb_shared2'), ('nb_young'), ('nb_reg'),
  ('src_old1'), ('chunk_old1'), ('msg_old1'), ('src_young'), ('msg_reg'),
  ('usage_anon'), ('usage_old'), ('usage_old_user_only'), ('usage_old_nulls'), ('usage_new'),
  ('audit_old_nb'), ('audit_new_nb');

create function pg_temp.id(key text) returns uuid as $$
  select x.v from pg_temp.fx x where x.k = $1;
$$ language sql stable;

create table pg_temp.res (k text primary key, v text);

-- ---------------------------------------------------------------------------
-- 1) The four functions: shape and lockdown
-- ---------------------------------------------------------------------------

select ok(pg_temp.fn_shape_ok('purge_expired_demo_users'),
  'private.purge_expired_demo_users() exists, is security invoker, returns integer and sets an empty search_path');
select ok(pg_temp.fn_locked_ok('purge_expired_demo_users'),
  'private.purge_expired_demo_users() is executable by neither PUBLIC, anon nor authenticated');
select ok(pg_temp.fn_shape_ok('purge_old_membership_audit'),
  'private.purge_old_membership_audit() exists, is security invoker, returns integer and sets an empty search_path');
select ok(pg_temp.fn_locked_ok('purge_old_membership_audit'),
  'private.purge_old_membership_audit() is executable by neither PUBLIC, anon nor authenticated');
select ok(pg_temp.fn_shape_ok('anonymize_old_usage'),
  'private.anonymize_old_usage() exists, is security invoker, returns integer and sets an empty search_path');
select ok(pg_temp.fn_locked_ok('anonymize_old_usage'),
  'private.anonymize_old_usage() is executable by neither PUBLIC, anon nor authenticated');

select pg_temp.act_throws(
  gen_random_uuid(), false,
  'select private.purge_expired_demo_users()',
  '42501',
  'authenticated cannot call private.purge_expired_demo_users() (42501)'
);

-- ---------------------------------------------------------------------------
-- 2) pg_cron jobs
-- ---------------------------------------------------------------------------

select pg_temp.safe_ok(
  $sql$ select count(*) = 4 from cron.job where left(jobname, 5) = 'nblm-' $sql$,
  'cron.job holds exactly the four nblm- jobs: the three demo and retention jobs and nblm-forget-deleted-users (other jobs are ignored)'
);
select pg_temp.safe_ok(
  $sql$ select count(*) = 1 from cron.job
        where jobname = 'nblm-purge-demo-users'
          and schedule = '*/15 * * * *'
          and command = 'select private.purge_expired_demo_users()' $sql$,
  'cron job nblm-purge-demo-users runs every 15 minutes and calls private.purge_expired_demo_users()'
);
select pg_temp.safe_ok(
  $sql$ select count(*) = 1 from cron.job
        where jobname = 'nblm-membership-audit-retention'
          and schedule = '17 3 * * *'
          and command = 'select private.purge_old_membership_audit()' $sql$,
  'cron job nblm-membership-audit-retention runs daily at 03:17 and calls private.purge_old_membership_audit()'
);
select pg_temp.safe_ok(
  $sql$ select count(*) = 1 from cron.job
        where jobname = 'nblm-usage-retention'
          and schedule = '27 3 * * *'
          and command = 'select private.anonymize_old_usage()' $sql$,
  'cron job nblm-usage-retention runs daily at 03:27 and calls private.anonymize_old_usage()'
);

-- ---------------------------------------------------------------------------
-- 3) Fixture for the purge
--    old_anon1/2/3  anonymous, 6000 days old     -> deleted
--    young_anon     anonymous, 23 hours old      -> kept
--    old_reg        regular,   6000 days old     -> kept
--    tmpl_owner     regular,   6000 days old     -> kept, owns the template
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
select pg_temp.id(k), k || '-' || pg_temp.id(k)::text || '@example.test', 'authenticated', 'authenticated', false,
       '{}'::jsonb, '{}'::jsonb, now() - interval '6000 days'
from (values ('old_reg'), ('tmpl_owner')) as t(k);

insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
select pg_temp.id(k), 'authenticated', 'authenticated', true, '{"provider": "anonymous"}'::jsonb, '{}'::jsonb, now() - interval '6000 days'
from (values ('old_anon1'), ('old_anon2'), ('old_anon3')) as t(k);

insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
values (pg_temp.id('young_anon'), 'authenticated', 'authenticated', true, '{"provider": "anonymous"}'::jsonb, '{}'::jsonb,
        now() - interval '23 hours');

-- 201 more expired anonymous users, younger than the three above but still the
-- oldest rows after them: one call must not delete all of them (batch of 200).
insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
select gen_random_uuid(), 'authenticated', 'authenticated', true, '{"provider": "anonymous"}'::jsonb,
       '{"pgtap_bulk": true}'::jsonb, now() - interval '5000 days' + (gs || ' seconds')::interval
from generate_series(1, 201) as gs;

-- Notebooks are created with a non-anonymous claim so the demo copy trigger (if it
-- exists yet) stays out of this file's way; ownership is what the purge looks at.
select pg_temp.act_lives(pg_temp.id('tmpl_owner'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('tmpl_nb'), 'pgtap template'),
  'fixture: the template owner creates the template notebook');
select pg_temp.act_lives(pg_temp.id('old_anon1'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_old1'), 'owned by an expired user'),
  'fixture: expired anonymous user 1 creates a notebook');
select pg_temp.act_lives(pg_temp.id('old_anon3'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_old2'), 'owned by another expired user'),
  'fixture: expired anonymous user 3 creates a notebook');
select pg_temp.act_lives(pg_temp.id('old_anon2'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_shared'), 'shared with a regular owner'),
  'fixture: expired anonymous user 2 creates a notebook that gets a second, regular owner');
select pg_temp.act_lives(pg_temp.id('old_anon1'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_shared2'), 'shared with a young owner'),
  'fixture: expired anonymous user 1 creates a notebook that gets a young second owner');
select pg_temp.act_lives(pg_temp.id('young_anon'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_young'), 'owned by a young user'),
  'fixture: the young anonymous user creates a notebook');
select pg_temp.act_lives(pg_temp.id('old_reg'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_reg'), 'owned by a regular user'),
  'fixture: the regular user creates a notebook');

select pg_temp.act_lives(pg_temp.id('old_anon2'), false,
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    pg_temp.id('nb_shared'), pg_temp.id('old_reg'), 'owner'),
  'fixture: user 2 adds the regular user as second owner');
select pg_temp.act_lives(pg_temp.id('old_anon1'), false,
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    pg_temp.id('nb_shared2'), pg_temp.id('young_anon'), 'owner'),
  'fixture: user 1 adds the young anonymous user as second owner (an audit row with actor = user 1)');
select pg_temp.act_lives(pg_temp.id('old_reg'), false,
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    pg_temp.id('nb_reg'), pg_temp.id('old_anon1'), 'viewer'),
  'fixture: the regular owner adds expired user 1 as viewer');

-- Register the template (replacing the seed's row), so the purge has a template
-- notebook it must leave alone.
select pg_temp.sql_lives('delete from private.demo_template', 'fixture: the existing template row is removed');
select pg_temp.sql_lives(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 1000, 'pgtap', 'pgtap fixture') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  'fixture: the template notebook is registered'
);

-- Content below the notebooks.
insert into public.sources (id, notebook_id, kind, title, status) values
  (pg_temp.id('tmpl_src'), pg_temp.id('tmpl_nb'), 'text', 'Template source', 'ready'),
  (pg_temp.id('src_old1'), pg_temp.id('nb_old1'), 'text', 'Expired source', 'ready'),
  (pg_temp.id('src_young'), pg_temp.id('nb_young'), 'text', 'Young source', 'ready');

insert into public.chunks (id, notebook_id, source_id, ordinal, content, page, embedding) values
  (pg_temp.id('chunk_old1'), pg_temp.id('nb_old1'), pg_temp.id('src_old1'), 0, 'expired chunk', null, pg_temp.unit_vec(1)::extensions.vector);

insert into public.messages (id, notebook_id, user_id, role, content) values
  (pg_temp.id('msg_old1'), pg_temp.id('nb_old1'), pg_temp.id('old_anon1'), 'assistant', 'expired answer'),
  (pg_temp.id('msg_reg'), pg_temp.id('nb_reg'), pg_temp.id('old_reg'), 'user', 'regular question');

insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values
  (pg_temp.id('msg_old1'), pg_temp.id('nb_old1'), 1, pg_temp.id('chunk_old1'), 'expired chunk');

insert into private.usage (id, user_id, notebook_id, kind, model_id, cost_usd)
values (pg_temp.id('usage_anon'), pg_temp.id('old_anon1'), pg_temp.id('nb_old1'), 'chat', 'pgtap-model', 0.5);

-- Preconditions: the fixture really holds what the assertions below look for.
select is(
  (select (select count(*) from public.notebooks where id = pg_temp.id('nb_old1'))
        + (select count(*) from public.sources where notebook_id = pg_temp.id('nb_old1'))
        + (select count(*) from public.chunks where notebook_id = pg_temp.id('nb_old1'))
        + (select count(*) from public.messages where notebook_id = pg_temp.id('nb_old1'))
        + (select count(*) from public.message_citations where notebook_id = pg_temp.id('nb_old1'))
        + (select count(*) from public.notebook_members where notebook_id = pg_temp.id('nb_old1'))),
  6::bigint,
  'fixture: the expired user''s notebook holds a source, chunk, message, citation and member row'
);

select cmp_ok(
  (select count(*) from private.membership_audit
   where user_id in (pg_temp.id('old_anon1'), pg_temp.id('old_anon2'), pg_temp.id('old_anon3'))
      or actor in (pg_temp.id('old_anon1'), pg_temp.id('old_anon2'), pg_temp.id('old_anon3'))),
  '>', 0::bigint,
  'fixture: the audit table references the expired users'
);

select is(
  (select count(*) from auth.users where raw_user_meta_data ->> 'pgtap_bulk' = 'true'),
  201::bigint,
  'fixture: 201 bulk anonymous users exist'
);

-- ---------------------------------------------------------------------------
-- 4) First purge call
-- ---------------------------------------------------------------------------

insert into pg_temp.res values ('purge1', pg_temp.sql_scalar('select private.purge_expired_demo_users()'));

select is((select v from pg_temp.res where k = 'purge1'), '200',
  'one purge call deletes exactly one batch of 200 expired anonymous users');

select is(
  (select count(*) from auth.users
   where id in (pg_temp.id('old_anon1'), pg_temp.id('old_anon2'), pg_temp.id('old_anon3'))),
  0::bigint,
  'the three oldest expired anonymous users are deleted'
);

select is(
  (select count(*) from auth.users where id = pg_temp.id('young_anon')),
  1::bigint,
  'an anonymous user younger than 24 hours is kept'
);

select is(
  (select count(*) from auth.users where id = pg_temp.id('old_reg')),
  1::bigint,
  'an old non-anonymous user is kept'
);

select is(
  (select count(*) from auth.users where id = pg_temp.id('tmpl_owner')),
  1::bigint,
  'the template owner is kept'
);

select is(
  (select (select count(*) from public.notebooks where id in (pg_temp.id('nb_old1'), pg_temp.id('nb_old2')))
        + (select count(*) from public.sources where notebook_id in (pg_temp.id('nb_old1'), pg_temp.id('nb_old2')))
        + (select count(*) from public.chunks where notebook_id in (pg_temp.id('nb_old1'), pg_temp.id('nb_old2')))
        + (select count(*) from public.messages where notebook_id in (pg_temp.id('nb_old1'), pg_temp.id('nb_old2')))
        + (select count(*) from public.message_citations where notebook_id in (pg_temp.id('nb_old1'), pg_temp.id('nb_old2')))
        + (select count(*) from public.notebook_members where notebook_id in (pg_temp.id('nb_old1'), pg_temp.id('nb_old2')))),
  0::bigint,
  'notebooks owned only by expired users are gone with their sources, chunks, messages, citations and members'
);

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_shared')) = 1
  and (select count(*) from public.notebook_members
       where notebook_id = pg_temp.id('nb_shared')
         and user_id = pg_temp.id('old_reg') and role = 'owner') = 1
  and (select count(*) from public.notebook_members where notebook_id = pg_temp.id('nb_shared')) = 1,
  'a notebook with a regular second owner is kept and only that owner remains'
);

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_shared2')) = 1
  and (select count(*) from public.notebook_members
       where notebook_id = pg_temp.id('nb_shared2')
         and user_id = pg_temp.id('young_anon') and role = 'owner') = 1
  and (select count(*) from public.notebook_members where notebook_id = pg_temp.id('nb_shared2')) = 1,
  'a notebook with a young second owner is kept and only that owner remains'
);

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_young')) = 1
  and (select count(*) from public.sources where notebook_id = pg_temp.id('nb_young')) = 1,
  'the notebook of a young anonymous user keeps its sources'
);

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_reg')) = 1
  and (select count(*) from public.messages where notebook_id = pg_temp.id('nb_reg')) = 1
  and (select count(*) from public.notebook_members
       where notebook_id = pg_temp.id('nb_reg') and user_id = pg_temp.id('old_reg') and role = 'owner') = 1
  and (select count(*) from public.notebook_members
       where notebook_id = pg_temp.id('nb_reg') and user_id = pg_temp.id('old_anon1')) = 0,
  'a regular notebook is kept with its messages; only the expired viewer''s membership is removed'
);

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('tmpl_nb')) = 1
  and (select count(*) from public.sources where notebook_id = pg_temp.id('tmpl_nb')) = 1,
  'the template notebook and its sources are untouched'
);

select pg_temp.safe_ok(
  format('select count(*) = 1 from private.demo_template where notebook_id = %L', pg_temp.id('tmpl_nb')),
  'private.demo_template still points at the template notebook'
);

select is(
  (select count(*) from private.membership_audit
   where user_id in (pg_temp.id('old_anon1'), pg_temp.id('old_anon2'), pg_temp.id('old_anon3'))
      or actor in (pg_temp.id('old_anon1'), pg_temp.id('old_anon2'), pg_temp.id('old_anon3'))),
  0::bigint,
  'no audit row references a purged user (user_id and actor are set to null)'
);

select cmp_ok(
  (select count(*) from private.membership_audit
   where notebook_id = pg_temp.id('nb_old1') and user_id is null),
  '>=', 1::bigint,
  'the audit rows of a deleted notebook stay, with the user id nulled'
);

select is(
  (select count(*) from private.membership_audit
   where notebook_id = pg_temp.id('nb_shared2')
     and user_id = pg_temp.id('young_anon') and actor is null),
  1::bigint,
  'an audit row whose actor was purged keeps the other user id and loses the actor'
);

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_anon') and user_id is null and notebook_id is null and cost_usd = 0.5) = 1,
  'the usage row of a purged user and notebook stays with its cost, references nulled'
);

select ok(
  (select count(*) from auth.users where raw_user_meta_data ->> 'pgtap_bulk' = 'true') between 1 and 200,
  'after the first call some of the 201 bulk users remain (batch limit)'
);

-- ---------------------------------------------------------------------------
-- 5) Second purge call finishes the backlog and keeps the right users
-- ---------------------------------------------------------------------------

insert into pg_temp.res values ('purge2', pg_temp.sql_scalar('select private.purge_expired_demo_users()'));

select pg_temp.safe_ok(
  format($sql$ select %L::int >= 1 $sql$, (select v from pg_temp.res where k = 'purge2')),
  'a second purge call deletes the remaining expired users'
);

select is(
  (select count(*) from auth.users where raw_user_meta_data ->> 'pgtap_bulk' = 'true'),
  0::bigint,
  'after the second call no bulk user remains'
);

select is(
  (select count(*) from auth.users
   where id in (pg_temp.id('young_anon'), pg_temp.id('old_reg'), pg_temp.id('tmpl_owner'))),
  3::bigint,
  'the young anonymous user, the regular user and the template owner are still there'
);

-- ---------------------------------------------------------------------------
-- 6) Membership audit retention (90 days)
-- ---------------------------------------------------------------------------

insert into private.membership_audit (notebook_id, user_id, actor, op, new_role, at) values
  (pg_temp.id('audit_old_nb'), null, null, 'insert', 'owner', now() - interval '91 days'),
  (pg_temp.id('audit_new_nb'), null, null, 'insert', 'owner', now() - interval '89 days');

insert into pg_temp.res values ('audit', pg_temp.sql_scalar('select private.purge_old_membership_audit()'));

select pg_temp.safe_ok(
  format($sql$ select %L::int >= 1 $sql$, (select v from pg_temp.res where k = 'audit')),
  'purge_old_membership_audit() returns the number of rows it deleted'
);

select is(
  (select count(*) from private.membership_audit where notebook_id = pg_temp.id('audit_old_nb')),
  0::bigint,
  'an audit row older than 90 days is deleted'
);

select is(
  (select count(*) from private.membership_audit where notebook_id = pg_temp.id('audit_new_nb')),
  1::bigint,
  'an audit row younger than 90 days is kept'
);

-- ---------------------------------------------------------------------------
-- 7) Usage anonymization (90 days): ids go, cost and timing stay
-- ---------------------------------------------------------------------------

insert into private.usage
  (id, user_id, notebook_id, message_id, kind, model_id, status, input_tokens, output_tokens,
   cost_usd, latency_ms, created_at, settled_at)
values
  (pg_temp.id('usage_old'), pg_temp.id('old_reg'), pg_temp.id('nb_reg'), pg_temp.id('msg_reg'),
   'chat', 'pgtap-model', 'settled', 10, 20, 0.1234, 150,
   now() - interval '91 days', now() - interval '91 days'),
  (pg_temp.id('usage_new'), pg_temp.id('old_reg'), pg_temp.id('nb_reg'), pg_temp.id('msg_reg'),
   'chat', 'pgtap-model', 'settled', 10, 20, 0.1234, 150,
   now() - interval '89 days', now() - interval '89 days');

insert into private.usage (id, user_id, kind, model_id, cost_usd, created_at)
values (pg_temp.id('usage_old_user_only'), pg_temp.id('old_reg'), 'embedding', 'pgtap-model', 0.01, now() - interval '91 days');

insert into private.usage (id, kind, model_id, cost_usd, created_at)
values (pg_temp.id('usage_old_nulls'), 'embedding', 'pgtap-model', 0.02, now() - interval '91 days');

insert into pg_temp.res values ('usage', pg_temp.sql_scalar('select private.anonymize_old_usage()'));

select pg_temp.safe_ok(
  format($sql$ select %L::int >= 2 $sql$, (select v from pg_temp.res where k = 'usage')),
  'anonymize_old_usage() returns the number of rows it changed (at least the two old rows with references)'
);

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_old')
     and user_id is null and notebook_id is null and message_id is null) = 1,
  'a usage row older than 90 days loses user_id, notebook_id and message_id'
);

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_old')
     and cost_usd = 0.1234 and input_tokens = 10 and output_tokens = 20 and latency_ms = 150
     and status = 'settled' and kind = 'chat' and model_id = 'pgtap-model'
     and created_at < now() - interval '90 days') = 1,
  'the anonymized row keeps cost, tokens, latency, status, kind, model and timestamp'
);

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_old_user_only')
     and user_id is null and notebook_id is null and message_id is null and cost_usd = 0.01) = 1,
  'an old row with only a user id is anonymized too'
);

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_new')
     and user_id = pg_temp.id('old_reg') and notebook_id = pg_temp.id('nb_reg')
     and message_id = pg_temp.id('msg_reg')) = 1,
  'a usage row younger than 90 days keeps its references'
);

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_old_nulls')
     and user_id is null and notebook_id is null and message_id is null and cost_usd = 0.02) = 1,
  'an old row without references is left as it was'
);

select * from finish();

rollback;
