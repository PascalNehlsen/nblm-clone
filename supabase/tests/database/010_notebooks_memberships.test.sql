-- Behavioural and function/table-property tests for PR 3 (notebooks,
-- notebook_members, private.notebook_role, the trigger functions and the
-- audit trail). 000_catalog.test.sql proves the general catalog invariants
-- every table/function must satisfy; this file proves PR 3's own contract:
-- bootstrap membership, the audit trail's content, and the last-owner guard.
--
-- This migration does not exist yet, so most assertions below are expected
-- to fail -- but the failures must be genuine pgTAP FAILs (missing
-- table/function/type), never a crashed script. Three custom pg_temp helpers
-- make that possible:
--
--   * pg_temp.safe_ok(probe, description)            -- "is this true?"
--   * pg_temp.act_lives(actor, probe, description)    -- "does this not throw,
--                                                         acting as `actor`?"
--   * pg_temp.act_throws(actor, probe, sqlstate, description)
--                                                      -- "does this throw
--                                                         exactly this
--                                                         SQLSTATE, acting as
--                                                         `actor`?"
--
-- Each wraps its dynamic `probe` SQL in its own BEGIN/EXCEPTION (a PL/pgSQL
-- construct, not a SQL SAVEPOINT the file issues itself -- the ban on
-- SAVEPOINT is about not rolling back over pgTAP's own result bookkeeping,
-- see 000_catalog.test.sql's header; PL/pgSQL's implicit exception
-- subtransaction is the mechanism pgTAP's own throws_ok/lives_ok use
-- internally for exactly this reason) and always emits exactly one pgTAP
-- assertion, whether the probe succeeds, fails validation, or errors because
-- a table/function/type referenced inside it does not exist yet. Custom
-- wrappers are used instead of pgTAP's own throws_ok/lives_ok so the exact
-- overload called (and therefore its exact behaviour) is never in doubt.
--
-- act_lives/act_throws do the role switch *inside* the function body (`set
-- local role authenticated`, `set_config('request.jwt.claims', ...)`, then
-- `reset role` before returning) rather than as separate statements around
-- the call, so every probe always runs from a known role regardless of
-- whether pg_temp functions are directly callable by `authenticated` (a
-- question this sidesteps rather than answers). The net effect for each
-- scenario below is exactly the sequence the contract describes: become the
-- acting user, run one statement, become postgres again.
--
-- Verification probes (safe_ok) run as whatever role is current when they
-- are called -- here, after act_lives/act_throws has already reset back to
-- the original connecting role -- deliberately bypassing RLS to read ground
-- truth about the audit trail and membership rows. RLS-filtered visibility
-- is covered by tests/rls/notebooks.test.ts and notebook_members.test.ts,
-- which exercise the real PostgREST/JWT path; this file is the only place
-- that can see private.membership_audit at all.

begin;

select plan(48);

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

create function pg_temp.act_throws(actor_id uuid, probe text, expected_sqlstate text, description text)
returns text as $$
declare
  actual_sqlstate text := null;
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
    get stacked diagnostics actual_sqlstate = returned_sqlstate;
  end;
  reset role;
  return is(actual_sqlstate, expected_sqlstate, description);
end;
$$ language plpgsql;

-- Scratch values shared across statements below (there is no session
-- variable mechanism at the top level of a .sql file, only tables).
create table pg_temp.scratch (
  notebook_a uuid not null,
  notebook_b uuid not null,
  owner_a uuid not null,
  editor_a uuid not null,
  owner_b uuid not null,
  owner_b2 uuid not null
);
insert into pg_temp.scratch
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

-- Test users, created directly in auth.users inside this transaction (it
-- already exists regardless of PR 3, so these inserts are not wrapped).
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select owner_a, owner_a::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from pg_temp.scratch;
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select editor_a, editor_a::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from pg_temp.scratch;
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select owner_b, owner_b::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from pg_temp.scratch;
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select owner_b2, owner_b2::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from pg_temp.scratch;

-- ---------------------------------------------------------------------------
-- 1) Function and table properties
-- ---------------------------------------------------------------------------

-- private.notebook_role(uuid)
select ok(to_regprocedure('private.notebook_role(uuid)') is not null, 'private.notebook_role(uuid) exists');
select ok(
  coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('private.notebook_role(uuid)')), false),
  'private.notebook_role(uuid) is security definer'
);
select ok(
  coalesce((select p.provolatile = 's' from pg_proc p where p.oid = to_regprocedure('private.notebook_role(uuid)')), false),
  'private.notebook_role(uuid) is stable'
);
select ok(
  coalesce(
    (select l.lanname = 'sql' from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('private.notebook_role(uuid)')),
    false
  ),
  'private.notebook_role(uuid) is language sql'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(p.proconfig, '{}')) from pg_proc p
     where p.oid = to_regprocedure('private.notebook_role(uuid)')),
    false
  ),
  'private.notebook_role(uuid) sets search_path to the empty string'
);
select ok(
  coalesce(
    (select p.prorettype = to_regtype('public.member_role') from pg_proc p
     where p.oid = to_regprocedure('private.notebook_role(uuid)')),
    false
  ),
  'private.notebook_role(uuid) returns public.member_role'
);
select ok(
  not coalesce(has_function_privilege('anon', to_regprocedure('private.notebook_role(uuid)'), 'EXECUTE'), false),
  'anon cannot execute private.notebook_role(uuid)'
);
select ok(
  coalesce(has_function_privilege('authenticated', to_regprocedure('private.notebook_role(uuid)'), 'EXECUTE'), false),
  'authenticated can execute private.notebook_role(uuid)'
);

-- private.add_notebook_owner()
select ok(to_regprocedure('private.add_notebook_owner()') is not null, 'private.add_notebook_owner() exists');
select ok(
  coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('private.add_notebook_owner()')), false),
  'private.add_notebook_owner() is security definer'
);
select ok(
  coalesce(
    (select p.prorettype = 'trigger'::regtype from pg_proc p where p.oid = to_regprocedure('private.add_notebook_owner()')),
    false
  ),
  'private.add_notebook_owner() returns trigger'
);
select ok(
  not coalesce(
    (select p.proacl is null or exists (
       select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) from pg_proc p where p.oid = to_regprocedure('private.add_notebook_owner()')),
    false
  ),
  'private.add_notebook_owner() is not executable by PUBLIC'
);
select ok(
  not coalesce(has_function_privilege('anon', to_regprocedure('private.add_notebook_owner()'), 'EXECUTE'), false),
  'anon cannot execute private.add_notebook_owner()'
);
select ok(
  not coalesce(has_function_privilege('authenticated', to_regprocedure('private.add_notebook_owner()'), 'EXECUTE'), false),
  'authenticated cannot execute private.add_notebook_owner()'
);

-- private.audit_membership()
select ok(to_regprocedure('private.audit_membership()') is not null, 'private.audit_membership() exists');
select ok(
  coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('private.audit_membership()')), false),
  'private.audit_membership() is security definer'
);
select ok(
  coalesce(
    (select p.prorettype = 'trigger'::regtype from pg_proc p where p.oid = to_regprocedure('private.audit_membership()')),
    false
  ),
  'private.audit_membership() returns trigger'
);
select ok(
  not coalesce(
    (select p.proacl is null or exists (
       select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) from pg_proc p where p.oid = to_regprocedure('private.audit_membership()')),
    false
  ),
  'private.audit_membership() is not executable by PUBLIC'
);
select ok(
  not coalesce(has_function_privilege('anon', to_regprocedure('private.audit_membership()'), 'EXECUTE'), false),
  'anon cannot execute private.audit_membership()'
);
select ok(
  not coalesce(has_function_privilege('authenticated', to_regprocedure('private.audit_membership()'), 'EXECUTE'), false),
  'authenticated cannot execute private.audit_membership()'
);

-- private.guard_last_owner()
select ok(to_regprocedure('private.guard_last_owner()') is not null, 'private.guard_last_owner() exists');
select ok(
  coalesce(
    (select not p.prosecdef from pg_proc p where p.oid = to_regprocedure('private.guard_last_owner()')),
    false
  ),
  'private.guard_last_owner() is security invoker'
);

-- RLS enabled
select ok(
  coalesce(
    (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'notebooks'),
    false
  ),
  'RLS is enabled on public.notebooks'
);
select ok(
  coalesce(
    (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'notebook_members'),
    false
  ),
  'RLS is enabled on public.notebook_members'
);
select ok(
  coalesce(
    (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'private' and c.relname = 'membership_audit'),
    false
  ),
  'RLS is enabled on private.membership_audit'
);

-- Grants: membership_audit denies everyone; anon has nothing on the two
-- public tables either (the RLS matrix in tests/rls/ already covers the full
-- authenticated-role grant shape for notebooks/notebook_members).
select ok(
  not coalesce(
    has_table_privilege('anon', to_regclass('private.membership_audit'), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    or has_any_column_privilege('anon', to_regclass('private.membership_audit'), 'SELECT,INSERT,UPDATE,REFERENCES'),
    false
  ),
  'anon has no privilege on private.membership_audit'
);
select ok(
  not coalesce(
    has_table_privilege('authenticated', to_regclass('private.membership_audit'), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    or has_any_column_privilege('authenticated', to_regclass('private.membership_audit'), 'SELECT,INSERT,UPDATE,REFERENCES'),
    false
  ),
  'authenticated has no privilege on private.membership_audit'
);
select ok(
  not coalesce(
    has_table_privilege('anon', to_regclass('public.notebooks'), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    or has_any_column_privilege('anon', to_regclass('public.notebooks'), 'SELECT,INSERT,UPDATE,REFERENCES'),
    false
  ),
  'anon has no privilege on public.notebooks'
);
select ok(
  not coalesce(
    has_table_privilege('anon', to_regclass('public.notebook_members'), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    or has_any_column_privilege('anon', to_regclass('public.notebook_members'), 'SELECT,INSERT,UPDATE,REFERENCES'),
    false
  ),
  'anon has no privilege on public.notebook_members'
);

-- ---------------------------------------------------------------------------
-- 2) Behaviour: bootstrap, audit trail, last-owner guard
-- ---------------------------------------------------------------------------

-- Scenario A: bootstrap membership + the bootstrap insert itself is audited.
select pg_temp.act_lives(
  (select owner_a from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_a from pg_temp.scratch), 'bootstrap audit test'),
  'the owner can create notebook A'
);

select pg_temp.safe_ok(
  format(
    $f$ select exists (
          select 1 from public.notebook_members
          where notebook_id = %L and user_id = %L and role = 'owner'
        )
        and (select count(*) from public.notebook_members where notebook_id = %L) = 1
    $f$,
    (select notebook_a from pg_temp.scratch), (select owner_a from pg_temp.scratch), (select notebook_a from pg_temp.scratch)
  ),
  'bootstrap creates exactly one (owner_a, owner) membership for notebook A'
);

select pg_temp.safe_ok(
  format(
    $f$ select exists (
          select 1 from private.membership_audit
          where notebook_id = %L and user_id = %L and op = 'insert'
            and old_role is null and new_role = 'owner' and actor = %L
        )
    $f$,
    (select notebook_a from pg_temp.scratch), (select owner_a from pg_temp.scratch), (select owner_a from pg_temp.scratch)
  ),
  'the bootstrap owner insert is audited (op=insert, old_role=null, new_role=owner, actor=owner_a)'
);

-- Scenario B: inserting a second member is audited.
select pg_temp.act_lives(
  (select owner_a from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_a from pg_temp.scratch), (select editor_a from pg_temp.scratch), 'editor'),
  'the owner can add an editor to notebook A'
);

select pg_temp.safe_ok(
  format(
    $f$ select exists (
          select 1 from private.membership_audit
          where notebook_id = %L and user_id = %L and op = 'insert'
            and old_role is null and new_role = 'editor' and actor = %L
        )
    $f$,
    (select notebook_a from pg_temp.scratch), (select editor_a from pg_temp.scratch), (select owner_a from pg_temp.scratch)
  ),
  'the editor insert is audited (op=insert, old_role=null, new_role=editor, actor=owner_a)'
);

-- Scenario C: a role change (update) is audited.
select pg_temp.act_lives(
  (select owner_a from pg_temp.scratch),
  format('update public.notebook_members set role = %L where notebook_id = %L and user_id = %L',
    'viewer', (select notebook_a from pg_temp.scratch), (select editor_a from pg_temp.scratch)),
  'the owner can change the editor''s role to viewer'
);

select pg_temp.safe_ok(
  format(
    $f$ select exists (
          select 1 from private.membership_audit
          where notebook_id = %L and user_id = %L and op = 'update'
            and old_role = 'editor' and new_role = 'viewer' and actor = %L
        )
    $f$,
    (select notebook_a from pg_temp.scratch), (select editor_a from pg_temp.scratch), (select owner_a from pg_temp.scratch)
  ),
  'the role-change update is audited (op=update, old_role=editor, new_role=viewer, actor=owner_a)'
);

-- Scenario D: a membership delete is audited.
select pg_temp.act_lives(
  (select owner_a from pg_temp.scratch),
  format('delete from public.notebook_members where notebook_id = %L and user_id = %L',
    (select notebook_a from pg_temp.scratch), (select editor_a from pg_temp.scratch)),
  'the owner can remove the former editor from notebook A'
);

select pg_temp.safe_ok(
  format(
    $f$ select exists (
          select 1 from private.membership_audit
          where notebook_id = %L and user_id = %L and op = 'delete'
            and old_role = 'viewer' and new_role is null and actor = %L
        )
    $f$,
    (select notebook_a from pg_temp.scratch), (select editor_a from pg_temp.scratch), (select owner_a from pg_temp.scratch)
  ),
  'the membership delete is audited (op=delete, old_role=viewer, new_role=null, actor=owner_a)'
);

-- Scenario E: deleting the notebook writes a delete audit row for its
-- (now sole) membership too.
select pg_temp.act_lives(
  (select owner_a from pg_temp.scratch),
  format('delete from public.notebooks where id = %L', (select notebook_a from pg_temp.scratch)),
  'the owner can delete notebook A'
);

select pg_temp.safe_ok(
  format(
    $f$ select exists (
          select 1 from private.membership_audit
          where notebook_id = %L and user_id = %L and op = 'delete'
            and old_role = 'owner' and new_role is null and actor = %L
        )
    $f$,
    (select notebook_a from pg_temp.scratch), (select owner_a from pg_temp.scratch), (select owner_a from pg_temp.scratch)
  ),
  'deleting notebook A writes a delete audit row for its owner membership'
);

-- Scenario F: last-owner guard on a fresh, single-owner notebook B.
select pg_temp.act_lives(
  (select owner_b from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_b from pg_temp.scratch), 'last-owner guard test'),
  'owner_b can create notebook B'
);

select pg_temp.act_throws(
  (select owner_b from pg_temp.scratch),
  format('update public.notebook_members set role = %L where notebook_id = %L and user_id = %L',
    'editor', (select notebook_b from pg_temp.scratch), (select owner_b from pg_temp.scratch)),
  'P0001',
  'the sole owner of notebook B cannot demote themselves (P0001)'
);

select pg_temp.act_throws(
  (select owner_b from pg_temp.scratch),
  format('delete from public.notebook_members where notebook_id = %L and user_id = %L',
    (select notebook_b from pg_temp.scratch), (select owner_b from pg_temp.scratch)),
  'P0001',
  'the sole owner of notebook B cannot delete their own membership (P0001)'
);

-- Scenario G: with a second owner, the first owner can demote themselves,
-- and deleting the notebook afterwards cascades without error.
select pg_temp.act_lives(
  (select owner_b from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_b from pg_temp.scratch), (select owner_b2 from pg_temp.scratch), 'owner'),
  'owner_b can add a second owner to notebook B'
);

select pg_temp.act_lives(
  (select owner_b from pg_temp.scratch),
  format('update public.notebook_members set role = %L where notebook_id = %L and user_id = %L',
    'editor', (select notebook_b from pg_temp.scratch), (select owner_b from pg_temp.scratch)),
  'owner_b can demote themselves once a second owner exists'
);

select pg_temp.safe_ok(
  format(
    $f$ select
          (select role from public.notebook_members where notebook_id = %L and user_id = %L) = 'editor'
          and (select role from public.notebook_members where notebook_id = %L and user_id = %L) = 'owner'
    $f$,
    (select notebook_b from pg_temp.scratch), (select owner_b from pg_temp.scratch),
    (select notebook_b from pg_temp.scratch), (select owner_b2 from pg_temp.scratch)
  ),
  'after the demotion, owner_b is editor and owner_b2 remains owner'
);

select pg_temp.act_lives(
  (select owner_b2 from pg_temp.scratch),
  format('delete from public.notebooks where id = %L', (select notebook_b from pg_temp.scratch)),
  'owner_b2 can delete notebook B, cascading away every remaining membership without error'
);

select pg_temp.safe_ok(
  format(
    $f$ select (select count(*) from public.notebook_members where notebook_id = %L) = 0 $f$,
    (select notebook_b from pg_temp.scratch)
  ),
  'no membership rows remain for notebook B after it is deleted'
);

select * from finish();

rollback;
