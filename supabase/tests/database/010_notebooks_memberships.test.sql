-- Behavioural and function/table-property tests for PR 3 (notebooks,
-- notebook_members, private.notebook_role, the trigger functions and the
-- audit trail). 000_catalog.test.sql proves the general catalog invariants
-- every table/function must satisfy; this file proves PR 3's own contract:
-- bootstrap membership, the audit trail's content, and the last-owner guard
-- -- including its behaviour under bulk (multi-row) delete/update, which a
-- single-row-at-a-time mental model misses.
--
-- Bulk-operation regression (found in review of PR 3): with two owners A and
-- B, A running a bulk `delete ... where notebook_id = X` (or a bulk `update
-- ... set role = 'viewer' where notebook_id = X`) deleted or demoted both.
-- The guard was SECURITY INVOKER, so its "does the notebook still exist"
-- lock ran under RLS; once A's own row was processed earlier in the same
-- statement, the notebook was hidden from A and looked deleted. The guard is
-- now a SECURITY DEFINER trigger (allowlisted, `for no key update`). The
-- scenarios use fixed uuids because the bug depended on primary key order.
--
-- Whether a probe currently fails because a schema object errors out, a
-- business rule isn't met, or (post-fix) succeeds, every probe must produce
-- a genuine pgTAP PASS/FAIL, never a crashed script. Three custom pg_temp
-- helpers make that possible:
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
-- assertion, whatever the probe does. Custom wrappers are used instead of
-- pgTAP's own throws_ok/lives_ok so the exact overload called (and therefore
-- its exact behaviour) is never in doubt.
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

select plan(74);

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
--
-- The bulk-operation regression (see file header) does not actually depend
-- on *insertion* order: notebook_members' primary key is (notebook_id,
-- user_id), so `where notebook_id = X` is satisfied via that index, and rows
-- come back in user_id order, not insertion order. Confirmed empirically by
-- running this file repeatedly with random ids: which of two structurally
-- identical scenarios reproduced the bug flipped between runs. What actually
-- matters is simply whether the acting user's own row sorts before or after
-- the other owner's row -- "acting row processed first" is the condition
-- that reproduces the bug (see file header for why). So the owner pairs for
-- scenarios I-L below use fixed, hand-picked uuids (not gen_random_uuid())
-- whose hex ordering is known, deliberately placing the acting owner first
-- in one pair and last in the other -- this is what "_first"/"_last" refer
-- to below, not insertion order -- so the suite reproduces the bug
-- deterministically instead of depending on random id generation.
create table pg_temp.scratch (
  notebook_a uuid not null,
  notebook_b uuid not null,
  owner_a uuid not null,
  editor_a uuid not null,
  owner_b uuid not null,
  owner_b2 uuid not null,
  notebook_three uuid not null,
  owner_p uuid not null,
  owner_q uuid not null,
  owner_r uuid not null,
  notebook_bd_first uuid not null,
  owner_bd_first_1 uuid not null,
  owner_bd_first_2 uuid not null,
  notebook_bd_last uuid not null,
  owner_bd_last_1 uuid not null,
  owner_bd_last_2 uuid not null,
  notebook_bu_first uuid not null,
  owner_bu_first_1 uuid not null,
  owner_bu_first_2 uuid not null,
  notebook_bu_last uuid not null,
  owner_bu_last_1 uuid not null,
  owner_bu_last_2 uuid not null
);
insert into pg_temp.scratch (
  notebook_a, notebook_b, owner_a, editor_a, owner_b, owner_b2,
  notebook_three, owner_p, owner_q, owner_r,
  notebook_bd_first, owner_bd_first_1, owner_bd_first_2,
  notebook_bd_last, owner_bd_last_1, owner_bd_last_2,
  notebook_bu_first, owner_bu_first_1, owner_bu_first_2,
  notebook_bu_last, owner_bu_last_1, owner_bu_last_2
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  -- bd_first: acting owner (owner_bd_first_1) sorts FIRST (low uuid).
  gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-bfff-fffffffffff1',
  -- bd_last: acting owner (owner_bd_last_2) sorts LAST (high uuid).
  gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'ffffffff-ffff-4fff-bfff-fffffffffff2',
  -- bu_first: acting owner (owner_bu_first_1) sorts FIRST (low uuid).
  gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'ffffffff-ffff-4fff-bfff-fffffffffff3',
  -- bu_last: acting owner (owner_bu_last_2) sorts LAST (high uuid).
  gen_random_uuid(), '00000000-0000-4000-8000-000000000004', 'ffffffff-ffff-4fff-bfff-fffffffffff4'
);

-- Test users, created directly in auth.users inside this transaction (it
-- already exists regardless of PR 3, so this insert is not wrapped). Built
-- from an array of every scratch user column (plain SQL, no PL/pgSQL), so
-- adding a new scenario above does not also require a new, hand-written
-- insert statement here.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (
  select unnest(array[
    owner_a, editor_a, owner_b, owner_b2,
    owner_p, owner_q, owner_r,
    owner_bd_first_1, owner_bd_first_2,
    owner_bd_last_1, owner_bd_last_2,
    owner_bu_first_1, owner_bu_first_2,
    owner_bu_last_1, owner_bu_last_2
  ]) as u
  from pg_temp.scratch
) as users;

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

-- private.guard_last_owner() -- SECURITY DEFINER as of the bulk-operation
-- fix (was SECURITY INVOKER; see the file header for why an invoker-rights
-- lock query was unsafe under RLS for a multi-row statement).
select ok(to_regprocedure('private.guard_last_owner()') is not null, 'private.guard_last_owner() exists');
select ok(
  coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('private.guard_last_owner()')), false),
  'private.guard_last_owner() is security definer'
);
select ok(
  coalesce(
    (select p.prorettype = 'trigger'::regtype from pg_proc p where p.oid = to_regprocedure('private.guard_last_owner()')),
    false
  ),
  'private.guard_last_owner() returns trigger'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(p.proconfig, '{}')) from pg_proc p
     where p.oid = to_regprocedure('private.guard_last_owner()')),
    false
  ),
  'private.guard_last_owner() sets search_path to the empty string'
);
select ok(
  not coalesce(
    (select p.proacl is null or exists (
       select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) from pg_proc p where p.oid = to_regprocedure('private.guard_last_owner()')),
    false
  ),
  'private.guard_last_owner() is not executable by PUBLIC'
);
select ok(
  not coalesce(has_function_privilege('anon', to_regprocedure('private.guard_last_owner()'), 'EXECUTE'), false),
  'anon cannot execute private.guard_last_owner()'
);
select ok(
  not coalesce(has_function_privilege('authenticated', to_regprocedure('private.guard_last_owner()'), 'EXECUTE'), false),
  'authenticated cannot execute private.guard_last_owner()'
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

-- Scenario H: one owner demotes a DIFFERENT owner (not themselves) while a
-- third owner remains -- distinct from scenario G's self-demote.
select pg_temp.act_lives(
  (select owner_p from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_three from pg_temp.scratch), 'three owners, demote another'),
  'owner_p can create a notebook with three eventual owners'
);
select pg_temp.act_lives(
  (select owner_p from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_three from pg_temp.scratch), (select owner_q from pg_temp.scratch), 'owner'),
  'owner_p can add owner_q as a second owner'
);
select pg_temp.act_lives(
  (select owner_p from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_three from pg_temp.scratch), (select owner_r from pg_temp.scratch), 'owner'),
  'owner_p can add owner_r as a third owner'
);
select pg_temp.act_lives(
  (select owner_p from pg_temp.scratch),
  format('update public.notebook_members set role = %L where notebook_id = %L and user_id = %L',
    'editor', (select notebook_three from pg_temp.scratch), (select owner_q from pg_temp.scratch)),
  'owner_p can demote owner_q to editor while owner_r remains an owner'
);
select pg_temp.safe_ok(
  format(
    $f$ select
          (select role from public.notebook_members where notebook_id = %L and user_id = %L) = 'editor'
          and (select role from public.notebook_members where notebook_id = %L and user_id = %L) = 'owner'
          and (select role from public.notebook_members where notebook_id = %L and user_id = %L) = 'owner'
    $f$,
    (select notebook_three from pg_temp.scratch), (select owner_q from pg_temp.scratch),
    (select notebook_three from pg_temp.scratch), (select owner_r from pg_temp.scratch),
    (select notebook_three from pg_temp.scratch), (select owner_p from pg_temp.scratch)
  ),
  'after the demotion, owner_q is editor while owner_p and owner_r remain owners'
);

-- Scenario I: the bulk-delete regression (see file header and the scratch
-- table comment above). Two owners; owner_bd_first_1's uuid is fixed to sort
-- BEFORE owner_bd_first_2's, so owner_bd_first_1's own membership row is the
-- one processed first within the bulk statement -- the ordering the
-- reported bug needs.
select pg_temp.act_lives(
  (select owner_bd_first_1 from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_bd_first from pg_temp.scratch), 'bulk delete regression, acting owner sorts first'),
  'owner_bd_first_1 can create notebook bd_first'
);
select pg_temp.act_lives(
  (select owner_bd_first_1 from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_bd_first from pg_temp.scratch), (select owner_bd_first_2 from pg_temp.scratch), 'owner'),
  'owner_bd_first_1 can add owner_bd_first_2 as a second owner'
);
select pg_temp.act_throws(
  (select owner_bd_first_1 from pg_temp.scratch),
  format('delete from public.notebook_members where notebook_id = %L', (select notebook_bd_first from pg_temp.scratch)),
  'P0001',
  'a bulk delete of both owners by owner_bd_first_1 (sorts first) raises P0001'
);
select pg_temp.safe_ok(
  format(
    $f$ select (select count(*) from public.notebook_members where notebook_id = %L) = 2 $f$,
    (select notebook_bd_first from pg_temp.scratch)
  ),
  'both owner rows remain for notebook bd_first after the rejected bulk delete'
);

-- Scenario J: the same bulk delete, but with the acting owner's uuid fixed
-- to sort LAST, so the fix must not depend on which row happens to be
-- processed first within the statement.
select pg_temp.act_lives(
  (select owner_bd_last_1 from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_bd_last from pg_temp.scratch), 'bulk delete regression, acting owner sorts last'),
  'owner_bd_last_1 can create notebook bd_last'
);
select pg_temp.act_lives(
  (select owner_bd_last_1 from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_bd_last from pg_temp.scratch), (select owner_bd_last_2 from pg_temp.scratch), 'owner'),
  'owner_bd_last_1 can add owner_bd_last_2 as a second owner'
);
select pg_temp.act_throws(
  (select owner_bd_last_2 from pg_temp.scratch),
  format('delete from public.notebook_members where notebook_id = %L', (select notebook_bd_last from pg_temp.scratch)),
  'P0001',
  'a bulk delete of both owners by owner_bd_last_2 (sorts last) raises P0001'
);
select pg_temp.safe_ok(
  format(
    $f$ select (select count(*) from public.notebook_members where notebook_id = %L) = 2 $f$,
    (select notebook_bd_last from pg_temp.scratch)
  ),
  'both owner rows remain for notebook bd_last after the rejected bulk delete'
);

-- Scenario K: the same regression via a bulk UPDATE (demote-everyone),
-- acting owner's uuid fixed to sort first.
select pg_temp.act_lives(
  (select owner_bu_first_1 from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_bu_first from pg_temp.scratch), 'bulk update regression, acting owner sorts first'),
  'owner_bu_first_1 can create notebook bu_first'
);
select pg_temp.act_lives(
  (select owner_bu_first_1 from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_bu_first from pg_temp.scratch), (select owner_bu_first_2 from pg_temp.scratch), 'owner'),
  'owner_bu_first_1 can add owner_bu_first_2 as a second owner'
);
select pg_temp.act_throws(
  (select owner_bu_first_1 from pg_temp.scratch),
  format('update public.notebook_members set role = %L where notebook_id = %L',
    'viewer', (select notebook_bu_first from pg_temp.scratch)),
  'P0001',
  'a bulk demote of both owners to viewer by owner_bu_first_1 (sorts first) raises P0001'
);
select pg_temp.safe_ok(
  format(
    $f$ select (select count(*) from public.notebook_members where notebook_id = %L and role = 'owner') = 2 $f$,
    (select notebook_bu_first from pg_temp.scratch)
  ),
  'both members of notebook bu_first remain owner after the rejected bulk demote'
);

-- Scenario L: the same bulk UPDATE, acting owner's uuid fixed to sort last.
select pg_temp.act_lives(
  (select owner_bu_last_1 from pg_temp.scratch),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_bu_last from pg_temp.scratch), 'bulk update regression, acting owner sorts last'),
  'owner_bu_last_1 can create notebook bu_last'
);
select pg_temp.act_lives(
  (select owner_bu_last_1 from pg_temp.scratch),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_bu_last from pg_temp.scratch), (select owner_bu_last_2 from pg_temp.scratch), 'owner'),
  'owner_bu_last_1 can add owner_bu_last_2 as a second owner'
);
select pg_temp.act_throws(
  (select owner_bu_last_2 from pg_temp.scratch),
  format('update public.notebook_members set role = %L where notebook_id = %L',
    'viewer', (select notebook_bu_last from pg_temp.scratch)),
  'P0001',
  'a bulk demote of both owners to viewer by owner_bu_last_2 (sorts last) raises P0001'
);
select pg_temp.safe_ok(
  format(
    $f$ select (select count(*) from public.notebook_members where notebook_id = %L and role = 'owner') = 2 $f$,
    (select notebook_bu_last from pg_temp.scratch)
  ),
  'both members of notebook bu_last remain owner after the rejected bulk demote'
);

select * from finish();

rollback;
