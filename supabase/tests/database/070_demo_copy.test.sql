-- F1 (demo login, database part): private.demo_template, the SECURITY DEFINER
-- trigger function private.copy_demo_template() and the trigger
-- notebooks_copy_demo_template on public.notebooks.
--
-- 000_catalog.test.sql proves the general invariants (RLS on, definer allowlist,
-- search_path, grants). This file proves F1's own contract: the table's shape,
-- constraints and lockdown, the function's properties, and the behaviour of the
-- copy: an anonymous caller's first notebook receives the template's READY
-- sources and chunks (embeddings included), a non-anonymous caller's notebook
-- receives nothing, and the three refusals (demo_notebook_exists,
-- demo_unavailable, demo_capacity) raise P0001 and leave no notebook behind.
--
-- The template is built inside the transaction (own owner, own notebook, own
-- sources and chunks) and registered in private.demo_template after deleting
-- whatever row the local seed put there, so the test does not depend on the
-- seed's content. Everything is rolled back at the end.
--
-- Every object that only exists after the F1 migration (private.demo_template,
-- the function, the trigger) is reached through dynamic probes
-- (pg_temp.sql_lives/sql_throws/act_*), to_regclass/to_regprocedure or
-- coalesce(..., false), so a missing object is a clean pgTAP FAIL and never
-- aborts the transaction. Plain fixture DML only touches tables that already
-- exist (auth.users, public.notebooks, sources, chunks).
--
-- An anonymous caller is simulated like the Auth server does it: role
-- authenticated, claims with "is_anonymous": true, and a matching
-- auth.users row with is_anonymous = true (the capacity count reads it).

begin;

select plan(64);

-- ---------------------------------------------------------------------------
-- Helpers (pg_temp does not persist across the psql connections pg_prove opens)
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

create function pg_temp.sql_throws(probe text, expected_sqlstate text, description text) returns text as $$
declare
  actual_sqlstate text := null;
begin
  begin
    execute probe;
  exception when others then
    get stacked diagnostics actual_sqlstate = returned_sqlstate;
  end;
  return is(actual_sqlstate, expected_sqlstate, description);
end;
$$ language plpgsql;

-- Runs `probe` as `actor_id` under role authenticated; `anon` is the value of
-- the is_anonymous claim.
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

-- The raised message_text, or '' if the probe did not error.
create function pg_temp.act_error_message(actor_id uuid, anon boolean, probe text) returns text as $$
declare
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
    get stacked diagnostics err_text = message_text;
  end;
  reset role;
  return err_text;
end;
$$ language plpgsql;

-- One scalar as `actor_id`; 'ERROR:<sqlstate>' on error.
create function pg_temp.act_scalar(actor_id uuid, anon boolean, probe text) returns text as $$
declare
  result text;
  err_state text;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated', 'is_anonymous', anon)::text,
    true
  );
  begin
    execute probe into result;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate;
    result := 'ERROR:' || err_state;
  end;
  reset role;
  return result;
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

-- A 1024-dim unit vector (all zeros, a 1 at `pos`), as text.
create function pg_temp.unit_vec(pos int) returns text as $$
  select '[' || string_agg(case when i = pos then '1' else '0' end, ',' order by i) || ']'
  from generate_series(1, 1024) as i;
$$ language sql;

-- Fixture ids.
create table pg_temp.fx (k text primary key, v uuid not null default gen_random_uuid());
insert into pg_temp.fx (k) values
  ('tmpl_owner'), ('tmpl_nb'), ('src_text'), ('src_url'), ('src_pending'),
  ('anon_a'), ('anon_b'), ('anon_c'), ('anon_d'), ('reg_user'),
  ('nb_a'), ('nb_a2'), ('nb_b'), ('nb_c_pre'), ('nb_c'), ('nb_d'),
  ('nb_reg'), ('nb_reg2'), ('nb_reg3'), ('nb_reg4'),
  ('conv_user'), ('nb_conv1'), ('nb_conv2');

create function pg_temp.id(key text) returns uuid as $$
  select x.v from pg_temp.fx x where x.k = $1;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 1) private.demo_template: shape and lockdown
-- ---------------------------------------------------------------------------

select ok(to_regclass('private.demo_template') is not null, 'private.demo_template exists');

select ok(
  coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('private.demo_template')), false),
  'private.demo_template has row level security enabled'
);

select ok(
  coalesce(
    (select count(distinct p.polcmd) = 4
            and bool_and(p.polcmd in ('r', 'a', 'w', 'd'))
     from pg_policy p where p.polrelid = to_regclass('private.demo_template')),
    false
  ),
  'private.demo_template has exactly separate select, insert, update and delete policies (no FOR ALL)'
);

select ok(
  coalesce(not has_table_privilege('authenticated', to_regclass('private.demo_template'),
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false),
  'authenticated has no table privilege on private.demo_template'
);

select ok(
  coalesce(not has_table_privilege('anon', to_regclass('private.demo_template'),
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false),
  'anon has no table privilege on private.demo_template'
);

-- ---------------------------------------------------------------------------
-- 2) private.copy_demo_template(): properties and trigger
-- ---------------------------------------------------------------------------

select ok(pg_temp.proc_oid('private', 'copy_demo_template') is not null, 'private.copy_demo_template() exists');

select ok(
  coalesce((select p.prosecdef from pg_proc p where p.oid = pg_temp.proc_oid('private', 'copy_demo_template')), false),
  'private.copy_demo_template() is SECURITY DEFINER (the allowlisted exception, ADR 0001)'
);

select ok(
  coalesce((select p.prorettype = 'trigger'::regtype from pg_proc p where p.oid = pg_temp.proc_oid('private', 'copy_demo_template')), false),
  'private.copy_demo_template() returns trigger'
);

select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(p.proconfig, '{}'))
     from pg_proc p where p.oid = pg_temp.proc_oid('private', 'copy_demo_template')),
    false
  ),
  'private.copy_demo_template() sets search_path to an exact empty string'
);

select ok(
  coalesce(not has_function_privilege('authenticated', pg_temp.proc_oid('private', 'copy_demo_template'), 'EXECUTE'), false),
  'authenticated cannot execute private.copy_demo_template()'
);

select ok(
  coalesce(not has_function_privilege('anon', pg_temp.proc_oid('private', 'copy_demo_template'), 'EXECUTE'), false),
  'anon cannot execute private.copy_demo_template()'
);

select ok(
  coalesce(
    (select p.proacl is not null
            and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
     from pg_proc p where p.oid = pg_temp.proc_oid('private', 'copy_demo_template')),
    false
  ),
  'private.copy_demo_template() has no EXECUTE for PUBLIC'
);

select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notebooks'
      and t.tgname = 'notebooks_copy_demo_template'
      and t.tgfoid = pg_temp.proc_oid('private', 'copy_demo_template')
      and not t.tgisinternal
      and (t.tgtype & 2) = 0   -- AFTER
      and (t.tgtype & 4) = 4   -- INSERT
      and (t.tgtype & 1) = 1   -- ROW
      and t.tgname > 'notebooks_add_owner' -- fires after the owner row exists
  ),
  'notebooks has an AFTER INSERT FOR EACH ROW trigger notebooks_copy_demo_template (sorts after notebooks_add_owner)'
);

-- ---------------------------------------------------------------------------
-- 3) Fixture: users, a template notebook with ready and pending sources
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data)
select pg_temp.id(k), k || '-' || pg_temp.id(k)::text || '@example.test', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb
from (values ('tmpl_owner'), ('reg_user'), ('conv_user')) as t(k);

insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data)
select pg_temp.id(k), 'authenticated', 'authenticated', true, '{"provider": "anonymous"}'::jsonb, '{}'::jsonb
from (values ('anon_a'), ('anon_b'), ('anon_c'), ('anon_d')) as t(k);

-- The template owner is NOT anonymous, so creating the notebook copies nothing.
select pg_temp.act_lives(
  pg_temp.id('tmpl_owner'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('tmpl_nb'), 'pgtap template'),
  'fixture: the template owner creates the template notebook'
);

insert into public.sources (id, notebook_id, kind, title, source_url, status) values
  (pg_temp.id('src_text'), pg_temp.id('tmpl_nb'), 'text', 'Demo Text', null, 'ready'),
  (pg_temp.id('src_url'), pg_temp.id('tmpl_nb'), 'url', 'Demo Url', 'https://example.test/demo', 'ready'),
  (pg_temp.id('src_pending'), pg_temp.id('tmpl_nb'), 'text', 'Demo pending', null, 'pending');

insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding) values
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_text'), 0, 'Erster Absatz des Textes.', null, pg_temp.unit_vec(1)::extensions.vector),
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_text'), 1, 'Zweiter Absatz des Textes.', 1, pg_temp.unit_vec(2)::extensions.vector),
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_text'), 2, 'Dritter Absatz des Textes.', 2, pg_temp.unit_vec(3)::extensions.vector),
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_url'), 0, 'Erster Absatz der Seite.', null, pg_temp.unit_vec(4)::extensions.vector),
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_url'), 1, 'Zweiter Absatz der Seite.', null, pg_temp.unit_vec(5)::extensions.vector),
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_url'), 2, 'Dritter Absatz der Seite.', 3, pg_temp.unit_vec(6)::extensions.vector),
  (pg_temp.id('tmpl_nb'), pg_temp.id('src_pending'), 0, 'pending chunk must not be copied', null, pg_temp.unit_vec(7)::extensions.vector);

-- Register this notebook as the template (replacing whatever the seed put there).
select pg_temp.sql_lives('delete from private.demo_template', 'fixture: the existing template row is removed');
select pg_temp.sql_lives(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 1000, 'pgtap', 'pgtap fixture') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  'fixture: the template notebook is registered in private.demo_template'
);

-- ---------------------------------------------------------------------------
-- 4) private.demo_template constraints (checks run before the key conflict)
-- ---------------------------------------------------------------------------

select pg_temp.sql_throws(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 0, 'pgtap', 'too low') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  '23514',
  'max_live_copies = 0 is rejected with 23514'
);

select pg_temp.sql_throws(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 1001, 'pgtap', 'too high') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  '23514',
  'max_live_copies = 1001 is rejected with 23514'
);

select pg_temp.sql_throws(
  format(
    $sql$ insert into private.demo_template (id, notebook_id, max_live_copies, updated_by, reason)
          values (false, %L, 10, 'pgtap', 'second row') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  '23514',
  'a row with id = false is rejected with 23514 (the id is the constant true)'
);

select pg_temp.sql_throws(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 10, 'pgtap', 'second row') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  '23505',
  'a second template row is rejected with 23505 (one row at most)'
);

select pg_temp.sql_throws(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 10, 'pgtap', '') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  '23514',
  'an empty reason is rejected with 23514'
);

-- ---------------------------------------------------------------------------
-- 5) Lockdown for API roles
-- ---------------------------------------------------------------------------

select pg_temp.act_throws(
  pg_temp.id('anon_a'), true,
  'select * from private.demo_template',
  '42501',
  'an anonymous user cannot read private.demo_template (42501)'
);

select pg_temp.act_throws(
  pg_temp.id('reg_user'), false,
  'select private.copy_demo_template()',
  '42501',
  'authenticated cannot call private.copy_demo_template() directly (42501)'
);

-- ---------------------------------------------------------------------------
-- 6) The copy for an anonymous caller
-- ---------------------------------------------------------------------------

select pg_temp.act_lives(
  pg_temp.id('anon_a'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_a'), 'Demo copy A'),
  'an anonymous user creates their first notebook'
);

select is(
  (select count(*) from public.sources where notebook_id = pg_temp.id('nb_a')),
  2::bigint,
  'the new notebook received exactly the template''s two ready sources'
);

select set_eq(
  format($q$ select title from public.sources where notebook_id = %L $q$, pg_temp.id('nb_a')),
  array['Demo Text', 'Demo Url'],
  'the copied sources carry the template''s titles'
);

select is_empty(
  format(
    $q$
    select * from (
      select title, kind, source_url, status from public.sources where notebook_id = %L and status = 'ready'
      except
      select title, kind, source_url, status from public.sources where notebook_id = %L
    ) l
    union all
    select * from (
      select title, kind, source_url, status from public.sources where notebook_id = %L
      except
      select title, kind, source_url, status from public.sources where notebook_id = %L and status = 'ready'
    ) r
    $q$,
    pg_temp.id('tmpl_nb'), pg_temp.id('nb_a'), pg_temp.id('nb_a'), pg_temp.id('tmpl_nb')
  ),
  'copied sources keep kind, title, source_url and are ready'
);

select is(
  (select count(*) from public.sources
   where notebook_id = pg_temp.id('nb_a')
     and id in (pg_temp.id('src_text'), pg_temp.id('src_url'), pg_temp.id('src_pending'))),
  0::bigint,
  'copied sources have new ids'
);

select is(
  (select count(*) from public.sources
   where notebook_id = pg_temp.id('nb_a') and created_by = pg_temp.id('anon_a')),
  2::bigint,
  'copied sources are created_by the anonymous user'
);

select is(
  (select count(*) from public.chunks where notebook_id = pg_temp.id('nb_a')),
  6::bigint,
  'the new notebook received the six chunks of the ready sources'
);

select is_empty(
  format(
    $q$
    with t as (
      select s.title, c.ordinal, c.content, c.page, c.embedding::text as emb
      from public.chunks c join public.sources s on s.id = c.source_id
      where c.notebook_id = %L and s.status = 'ready'
    ), n as (
      select s.title, c.ordinal, c.content, c.page, c.embedding::text as emb
      from public.chunks c join public.sources s on s.id = c.source_id
      where c.notebook_id = %L
    )
    select * from (select * from t except select * from n) l
    union all
    select * from (select * from n except select * from t) r
    $q$,
    pg_temp.id('tmpl_nb'), pg_temp.id('nb_a')
  ),
  'copied chunks keep ordinal, content, page and embedding'
);

select is(
  (select count(*) from public.chunks c
   join public.sources s on s.id = c.source_id and s.notebook_id = c.notebook_id
   where c.notebook_id = pg_temp.id('nb_a')),
  6::bigint,
  'every copied chunk points at a source of the new notebook'
);

select is(
  (select (select count(*) from public.sources where notebook_id = pg_temp.id('nb_a') and title = 'Demo pending')
        + (select count(*) from public.chunks where notebook_id = pg_temp.id('nb_a') and content like 'pending%')),
  0::bigint,
  'the template''s pending source and its chunk are not copied'
);

select ok(
  (select count(*) from public.sources where notebook_id = pg_temp.id('tmpl_nb')) = 3
  and (select count(*) from public.chunks where notebook_id = pg_temp.id('tmpl_nb')) = 7,
  'the template notebook itself is unchanged'
);

select ok(
  (select count(*) from public.notebook_members
   where notebook_id = pg_temp.id('nb_a') and user_id = pg_temp.id('anon_a') and role = 'owner') = 1,
  'the anonymous user is the owner of the new notebook'
);

select is(
  pg_temp.act_scalar(pg_temp.id('anon_a'), true,
    format('select count(*)::text from public.sources where notebook_id = %L', pg_temp.id('nb_a'))),
  '2',
  'the anonymous user reads the copied sources through RLS'
);

select is(
  pg_temp.act_scalar(pg_temp.id('anon_a'), true,
    format('select count(*)::text from public.chunks where notebook_id = %L', pg_temp.id('nb_a'))),
  '6',
  'the anonymous user reads the copied chunks through RLS'
);

-- demo_notebook_exists: one notebook per anonymous user.
select pg_temp.act_throws(
  pg_temp.id('anon_a'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_a2'), 'Second demo notebook'),
  'P0001',
  'a second notebook for the same anonymous user is refused with P0001'
);

select ok(
  pg_temp.act_error_message(
    pg_temp.id('anon_a'), true,
    format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_a2'), 'Second demo notebook')
  ) ilike '%demo_notebook_exists%',
  'the refusal says demo_notebook_exists'
);

select is(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_a2')),
  0::bigint,
  'the refused second notebook was not created'
);

-- ---------------------------------------------------------------------------
-- 7) Non-anonymous callers: nothing is copied, nothing is refused
-- ---------------------------------------------------------------------------

select pg_temp.act_lives(
  pg_temp.id('reg_user'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_reg'), 'Regular notebook'),
  'a non-anonymous user creates a notebook'
);

select is(
  (select (select count(*) from public.sources where notebook_id = pg_temp.id('nb_reg'))
        + (select count(*) from public.chunks where notebook_id = pg_temp.id('nb_reg'))),
  0::bigint,
  'a non-anonymous user''s notebook receives no copied sources or chunks'
);

-- The claim decides, not the auth.users row: a row flagged anonymous whose token
-- says is_anonymous = false behaves like a regular caller.
select pg_temp.act_lives(
  pg_temp.id('anon_c'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_c_pre'), 'Pre-existing notebook'),
  'a caller whose claim says non-anonymous creates a notebook'
);

select is(
  (select count(*) from public.sources where notebook_id = pg_temp.id('nb_c_pre')),
  0::bigint,
  'the is_anonymous claim, not the auth.users flag, decides: nothing was copied'
);

-- The reverse: the token still says is_anonymous = true, but the auth.users row
-- says false (an account converted to a regular one, old token still valid). The
-- function must require both, so this caller gets no copy and no refusal, also
-- not for a second notebook.
select pg_temp.act_lives(
  pg_temp.id('conv_user'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_conv1'), 'Converted account, old token'),
  'a converted account with an old is_anonymous token creates a notebook without a refusal'
);

select pg_temp.act_lives(
  pg_temp.id('conv_user'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_conv2'), 'Converted account, second notebook'),
  'the same caller creates a second notebook without demo_notebook_exists'
);

select is(
  (select (select count(*) from public.sources where notebook_id in (pg_temp.id('nb_conv1'), pg_temp.id('nb_conv2')))
        + (select count(*) from public.chunks where notebook_id in (pg_temp.id('nb_conv1'), pg_temp.id('nb_conv2')))),
  0::bigint,
  'the auth.users flag is required too: a converted account with an old token gets no copy'
);

-- ---------------------------------------------------------------------------
-- 8) demo_notebook_exists for a caller who is already a member elsewhere
-- ---------------------------------------------------------------------------

select pg_temp.act_throws(
  pg_temp.id('anon_c'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_c'), 'Demo for C'),
  'P0001',
  'an anonymous caller who is a member of another notebook is refused with P0001'
);

select ok(
  pg_temp.act_error_message(
    pg_temp.id('anon_c'), true,
    format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_c'), 'Demo for C')
  ) ilike '%demo_notebook_exists%',
  'that refusal says demo_notebook_exists'
);

select is(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_c')),
  0::bigint,
  'the refused notebook was not created'
);

-- ---------------------------------------------------------------------------
-- 9) demo_unavailable: no template registered
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives('delete from private.demo_template', 'the template row is removed for the unavailable case');

select pg_temp.act_throws(
  pg_temp.id('anon_d'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_d'), 'Demo for D'),
  'P0001',
  'without a template row an anonymous notebook insert is refused with P0001'
);

select ok(
  pg_temp.act_error_message(
    pg_temp.id('anon_d'), true,
    format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_d'), 'Demo for D')
  ) ilike '%demo_unavailable%',
  'that refusal says demo_unavailable'
);

select is(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_d')),
  0::bigint,
  'the refused notebook was not created while the template is unavailable'
);

select pg_temp.act_lives(
  pg_temp.id('reg_user'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_reg2'), 'Regular notebook while unavailable'),
  'a non-anonymous user can still create notebooks while no template is registered'
);

select pg_temp.sql_lives(
  format(
    $sql$ insert into private.demo_template (notebook_id, max_live_copies, updated_by, reason)
          values (%L, 1000, 'pgtap', 'pgtap fixture restored') $sql$,
    pg_temp.id('tmpl_nb')
  ),
  'the template row is registered again'
);

-- ---------------------------------------------------------------------------
-- 10) demo_capacity
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  'update private.demo_template set max_live_copies = 1',
  'the cap is lowered to 1 (anonymous user A already owns a copy)'
);

select pg_temp.act_throws(
  pg_temp.id('anon_b'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_b'), 'Demo for B'),
  'P0001',
  'at capacity an anonymous notebook insert is refused with P0001'
);

select ok(
  pg_temp.act_error_message(
    pg_temp.id('anon_b'), true,
    format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_b'), 'Demo for B')
  ) ilike '%demo_capacity%',
  'that refusal says demo_capacity'
);

select is(
  (select count(*) from public.notebooks where id = pg_temp.id('nb_b')),
  0::bigint,
  'the refused notebook was not created at capacity'
);

select pg_temp.act_lives(
  pg_temp.id('reg_user'), false,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_reg3'), 'Regular notebook at capacity'),
  'a non-anonymous user is not limited by the demo capacity'
);

select pg_temp.sql_lives(
  'update private.demo_template set max_live_copies = 1000',
  'the cap is raised again'
);

select pg_temp.act_lives(
  pg_temp.id('anon_b'), true,
  format('insert into public.notebooks (id, title) values (%L, %L)', pg_temp.id('nb_b'), 'Demo for B'),
  'after raising the cap the same anonymous user gets their notebook'
);

select is(
  (select count(*) from public.sources where notebook_id = pg_temp.id('nb_b')),
  2::bigint,
  'and that notebook receives the two ready template sources'
);

select * from finish();

rollback;
