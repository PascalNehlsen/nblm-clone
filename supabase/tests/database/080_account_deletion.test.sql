-- Account deletion (database part). The app deletes the notebooks a user owns alone, then
-- the auth user (service_role, server side). This file proves what the database must do
-- around that:
--
--   * the existing last-owner guard still rejects deleting a sole owner from auth.users
--     while one of their notebooks exists (P0001), and changes nothing when it does;
--   * once that notebook is deleted first, the auth user delete succeeds and the user's
--     memberships, messages and their citations are gone, a notebook with another owner
--     survives without them, and private.usage keeps its rows with user_id nulled;
--   * private.forget_deleted_users_in_audit() (new, security invoker, empty search_path,
--     executable by nobody but its owner) nulls user_id and actor in private.membership_audit
--     for users that no longer exist in auth.users, and for nobody else;
--   * the pg_cron job nblm-forget-deleted-users runs it every 15 minutes.
--
-- Red before the migration: the function and the cron job do not exist, so the shape,
-- lockdown, cron and sweep assertions fail. Everything the migration does not touch (guard,
-- cascades, usage) is asserted too, so a later change that breaks the order of deletion is
-- caught here. All data is created inside the transaction and rolled back. The function and
-- the cron row are reached through dynamic probes, so a missing object is a clean pgTAP FAIL.

begin;

select plan(36);

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

-- 'OK' when the statement ran, otherwise the SQLSTATE. The statement is rolled back with
-- its sub-transaction when it fails.
create function pg_temp.sqlstate_of(probe text) returns text as $$
declare
  state text := 'OK';
begin
  begin
    execute probe;
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
  end;
  return state;
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

-- Runs a probe as a database role (anon or authenticated) and compares the SQLSTATE.
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

-- Exists, security invoker, exact empty search_path.
create function pg_temp.fn_shape_ok(fn text) returns boolean as $$
  select coalesce(
    (select not p.prosecdef and 'search_path=""' = any(coalesce(p.proconfig, '{}'))
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
  ('owner'), ('other'), ('editor'), ('viewer'),
  ('nb_sole'), ('nb_co'), ('nb_foreign'),
  ('src_sole'), ('src_co'), ('chunk_sole'), ('chunk_co'),
  ('msg_sole_owner'), ('msg_sole_editor'), ('msg_co_owner'), ('msg_co_other'), ('msg_foreign_owner'),
  ('usage_owner'),
  ('audit_live_nb'), ('audit_mixed_nb'), ('audit_ghost_nb'), ('ghost');

create function pg_temp.id(key text) returns uuid as $$
  select x.v from pg_temp.fx x where x.k = $1;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 1) The sweep function, its lockdown and the cron job
-- ---------------------------------------------------------------------------

select ok(pg_temp.fn_shape_ok('forget_deleted_users_in_audit'),
  'private.forget_deleted_users_in_audit() exists, is security invoker and sets an empty search_path');
select ok(pg_temp.fn_locked_ok('forget_deleted_users_in_audit'),
  'private.forget_deleted_users_in_audit() is executable by neither PUBLIC, anon nor authenticated');
select pg_temp.role_throws('authenticated', 'select private.forget_deleted_users_in_audit()', '42501',
  'authenticated cannot call private.forget_deleted_users_in_audit() (42501)');
select pg_temp.role_throws('anon', 'select private.forget_deleted_users_in_audit()', '42501',
  'anon cannot call private.forget_deleted_users_in_audit() (42501)');
select pg_temp.safe_ok(
  $sql$ select count(*) = 1 from cron.job
        where jobname = 'nblm-forget-deleted-users'
          and schedule = '*/15 * * * *'
          and command = 'select private.forget_deleted_users_in_audit()' $sql$,
  'cron job nblm-forget-deleted-users runs every 15 minutes and calls private.forget_deleted_users_in_audit()'
);

-- ---------------------------------------------------------------------------
-- 2) Fixture
--    owner    deletes their account
--    other    co-owns nb_co with owner, owns nb_foreign alone (owner is its editor)
--    editor   editor of nb_sole;  viewer  viewer of nb_sole
--    nb_sole  owned by owner alone: source, chunk, a message each by owner and editor, a citation
--    nb_co    owned by owner and other: source, chunk, a message each, a citation on owner's answer
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data)
select pg_temp.id(k), k || '-' || pg_temp.id(k)::text || '@example.test', 'authenticated', 'authenticated', false,
       '{}'::jsonb, '{}'::jsonb
from (values ('owner'), ('other'), ('editor'), ('viewer')) as t(k);

select pg_temp.act_lives(pg_temp.id('owner'),
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_sole'), 'pgtap sole'),
  'fixture: owner creates the notebook they own alone');
select pg_temp.act_lives(pg_temp.id('owner'),
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_co'), 'pgtap co-owned'),
  'fixture: owner creates the notebook that gets a second owner');
select pg_temp.act_lives(pg_temp.id('other'),
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_foreign'), 'pgtap foreign'),
  'fixture: other creates their own notebook');
select pg_temp.act_lives(pg_temp.id('owner'),
  format($sql$ insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, 'editor'), (%L, %L, 'viewer') $sql$,
    pg_temp.id('nb_sole'), pg_temp.id('editor'), pg_temp.id('nb_sole'), pg_temp.id('viewer')),
  'fixture: owner adds an editor and a viewer to the sole-owned notebook');
select pg_temp.act_lives(pg_temp.id('owner'),
  format($sql$ insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, 'owner') $sql$,
    pg_temp.id('nb_co'), pg_temp.id('other')),
  'fixture: owner adds other as second owner of nb_co');
select pg_temp.act_lives(pg_temp.id('other'),
  format($sql$ insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, 'editor') $sql$,
    pg_temp.id('nb_foreign'), pg_temp.id('owner')),
  'fixture: other adds owner as editor of nb_foreign');

insert into public.sources (id, notebook_id, kind, title, status) values
  (pg_temp.id('src_sole'), pg_temp.id('nb_sole'), 'text', 'sole source', 'ready'),
  (pg_temp.id('src_co'), pg_temp.id('nb_co'), 'text', 'co-owned source', 'ready');

insert into public.chunks (id, notebook_id, source_id, ordinal, content, page, embedding) values
  (pg_temp.id('chunk_sole'), pg_temp.id('nb_sole'), pg_temp.id('src_sole'), 0, 'sole chunk', null, pg_temp.unit_vec(1)::extensions.vector),
  (pg_temp.id('chunk_co'), pg_temp.id('nb_co'), pg_temp.id('src_co'), 0, 'co-owned chunk', null, pg_temp.unit_vec(2)::extensions.vector);

insert into public.messages (id, notebook_id, user_id, role, content) values
  (pg_temp.id('msg_sole_owner'), pg_temp.id('nb_sole'), pg_temp.id('owner'), 'assistant', 'owner answer in sole'),
  (pg_temp.id('msg_sole_editor'), pg_temp.id('nb_sole'), pg_temp.id('editor'), 'user', 'editor question in sole'),
  (pg_temp.id('msg_co_owner'), pg_temp.id('nb_co'), pg_temp.id('owner'), 'assistant', 'owner answer in co-owned'),
  (pg_temp.id('msg_co_other'), pg_temp.id('nb_co'), pg_temp.id('other'), 'user', 'other question in co-owned'),
  (pg_temp.id('msg_foreign_owner'), pg_temp.id('nb_foreign'), pg_temp.id('owner'), 'user', 'owner question in foreign');

insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values
  (pg_temp.id('msg_sole_owner'), pg_temp.id('nb_sole'), 1, pg_temp.id('chunk_sole'), 'sole chunk'),
  (pg_temp.id('msg_co_owner'), pg_temp.id('nb_co'), 1, pg_temp.id('chunk_co'), 'co-owned chunk');

insert into private.usage (id, user_id, notebook_id, kind, model_id, cost_usd)
values (pg_temp.id('usage_owner'), pg_temp.id('owner'), pg_temp.id('nb_sole'), 'chat', 'pgtap-model', 0.5);

-- Preconditions: the assertions below only mean something if this is really there.
select is(
  (select count(*) from public.notebook_members where user_id = pg_temp.id('owner')),
  3::bigint,
  'fixture: owner is a member of nb_sole, nb_co and nb_foreign');

select is(
  (select (select count(*) from public.sources where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.chunks where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.messages where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.message_citations where notebook_id = pg_temp.id('nb_sole'))),
  5::bigint,
  'fixture: the sole-owned notebook holds a source, a chunk, two messages and a citation');

-- ---------------------------------------------------------------------------
-- 3) The guard: a sole owner cannot be deleted while their notebook exists
-- ---------------------------------------------------------------------------

select is(
  pg_temp.sqlstate_of(format('delete from auth.users where id = %L', pg_temp.id('owner'))),
  'P0001',
  'deleting a sole owner from auth.users before their notebook is deleted is rejected by the last-owner guard (P0001)');

select ok(
  (select count(*) from auth.users where id = pg_temp.id('owner')) = 1
  and (select count(*) from public.notebook_members where user_id = pg_temp.id('owner')) = 3
  and (select count(*) from public.messages where user_id = pg_temp.id('owner')) = 3
  and (select count(*) from public.notebooks where id = pg_temp.id('nb_sole')) = 1,
  'the rejected delete changed nothing: user, memberships, messages and the notebook are all still there');

-- ---------------------------------------------------------------------------
-- 4) Notebook first, then the user
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  format('delete from public.notebooks where id = %L', pg_temp.id('nb_sole')),
  'the sole-owned notebook is deleted first (what the app does for every notebook the user owns alone)');

select is(
  (select (select count(*) from public.notebooks where id = pg_temp.id('nb_sole'))
        + (select count(*) from public.notebook_members where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.sources where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.chunks where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.messages where notebook_id = pg_temp.id('nb_sole'))
        + (select count(*) from public.message_citations where notebook_id = pg_temp.id('nb_sole'))),
  0::bigint,
  'nothing of the sole-owned notebook is left: members, sources, chunks, messages (also the editor''s) and citations');

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_owner') and user_id = pg_temp.id('owner') and notebook_id is null and cost_usd = 0.5) = 1,
  'deleting the notebook keeps the usage row (cost stays, notebook reference nulled)');

select cmp_ok(
  (select count(*) from private.membership_audit where user_id = pg_temp.id('owner') or actor = pg_temp.id('owner')),
  '>', 0::bigint,
  'fixture: the audit table references the owner before the user is deleted');

select pg_temp.sql_lives(
  format('delete from auth.users where id = %L', pg_temp.id('owner')),
  'with the notebook gone, deleting the auth user succeeds');

select is(
  (select count(*) from auth.users where id = pg_temp.id('owner')),
  0::bigint,
  'the auth user is gone');

select is(
  (select count(*) from public.notebook_members where user_id = pg_temp.id('owner')),
  0::bigint,
  'no membership of the deleted user is left, in any notebook');

select is(
  (select count(*) from public.messages where user_id = pg_temp.id('owner')),
  0::bigint,
  'no message of the deleted user is left, in any notebook');

select is(
  (select count(*) from public.message_citations where message_id = pg_temp.id('msg_co_owner')),
  0::bigint,
  'the citations of the deleted user''s answer in a surviving notebook are gone with the answer');

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_co')) = 1
  and (select count(*) from public.notebook_members where notebook_id = pg_temp.id('nb_co')) = 1
  and (select count(*) from public.notebook_members
       where notebook_id = pg_temp.id('nb_co') and user_id = pg_temp.id('other') and role = 'owner') = 1
  and (select count(*) from public.sources where id = pg_temp.id('src_co')) = 1
  and (select count(*) from public.chunks where id = pg_temp.id('chunk_co')) = 1
  and (select count(*) from public.messages where id = pg_temp.id('msg_co_other')) = 1,
  'the co-owned notebook survives with the other owner alone, and keeps its source, chunk and the other owner''s message');

select ok(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_foreign')) = 1
  and (select count(*) from public.notebook_members where notebook_id = pg_temp.id('nb_foreign')) = 1
  and (select count(*) from public.notebook_members
       where notebook_id = pg_temp.id('nb_foreign') and user_id = pg_temp.id('other') and role = 'owner') = 1,
  'a notebook the user was only an editor of survives, minus their membership');

select is(
  (select count(*) from auth.users where id in (pg_temp.id('editor'), pg_temp.id('viewer'), pg_temp.id('other'))),
  3::bigint,
  'the other users are untouched');

select ok(
  (select count(*) from private.usage
   where id = pg_temp.id('usage_owner') and user_id is null and notebook_id is null and cost_usd = 0.5) = 1,
  'the usage row stays with its cost and user_id nulled');

select cmp_ok(
  (select count(*) from private.membership_audit where user_id = pg_temp.id('owner') or actor = pg_temp.id('owner')),
  '>', 0::bigint,
  'before the sweep the audit table still references the deleted user (user_id has no foreign key)');

-- ---------------------------------------------------------------------------
-- 5) The sweep
--    audit_live_nb   user_id other (live), actor editor (live)   -> untouched
--    audit_mixed_nb  user_id editor (live), actor owner (deleted) -> actor nulled only
--    audit_ghost_nb  user_id with no auth.users row               -> nulled
-- ---------------------------------------------------------------------------

insert into private.membership_audit (notebook_id, user_id, actor, op, new_role) values
  (pg_temp.id('audit_live_nb'), pg_temp.id('other'), pg_temp.id('editor'), 'insert', 'editor'),
  (pg_temp.id('audit_mixed_nb'), pg_temp.id('editor'), pg_temp.id('owner'), 'insert', 'editor'),
  (pg_temp.id('audit_ghost_nb'), pg_temp.id('ghost'), null, 'insert', 'viewer');

select pg_temp.sql_lives('select private.forget_deleted_users_in_audit()',
  'the sweep runs (as the owner of the function, like pg_cron)');

select is(
  (select count(*) from private.membership_audit
   where user_id = pg_temp.id('owner') or actor = pg_temp.id('owner')),
  0::bigint,
  'after the sweep no audit row references the deleted user (user_id and actor are nulled)');

select cmp_ok(
  (select count(*) from private.membership_audit where notebook_id = pg_temp.id('nb_sole') and user_id is null),
  '>=', 1::bigint,
  'the audit rows of the deleted notebook stay, with the user id nulled');

select is(
  (select count(*) from private.membership_audit
   where notebook_id = pg_temp.id('audit_live_nb')
     and user_id = pg_temp.id('other') and actor = pg_temp.id('editor')),
  1::bigint,
  'an audit row that only references live users is untouched');

select is(
  (select count(*) from private.membership_audit
   where notebook_id = pg_temp.id('audit_mixed_nb')
     and user_id = pg_temp.id('editor') and actor is null),
  1::bigint,
  'an audit row whose actor was deleted keeps the live user_id and loses only the actor');

select is(
  (select count(*) from private.membership_audit
   where notebook_id = pg_temp.id('audit_ghost_nb') and user_id is null),
  1::bigint,
  'an audit row whose user_id matches no auth user is nulled');

select cmp_ok(
  (select count(*) from private.membership_audit where user_id = pg_temp.id('other')),
  '>', 0::bigint,
  'audit rows of live users keep their user_id');

select * from finish();

rollback;
