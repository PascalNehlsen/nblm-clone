-- Catalog and behavioural tests for PR E1 (private.model_settings,
-- private.usage, public.reserve_model_call, public.settle_model_call).
-- 000_catalog.test.sql proves the general invariants every table/function in
-- public/private must satisfy (RLS on, no FOR ALL policy, SECURITY DEFINER
-- allowlist, anon/authenticated have nothing in private, etc); this file
-- proves E1's own contract: the exact column shapes, the service_role-only
-- grant shape (including the column-restricted UPDATE on private.usage), the
-- seeded-disabled singleton row, the kill switch and per-user/per-anonymous/
-- global budget arithmetic (precedence, exact-at-limit, reserved/failed rows
-- counting), the Europe/Berlin day boundary, settle's idempotency, and the
-- FK ON DELETE SET NULL actions onto messages/notebooks/auth.users.
--
-- Both tables live in `private`, which PostgREST never exposes, and both
-- functions are callable only by `service_role` -- there is no RLS matrix of
-- owner/editor/viewer/stranger here the way there is for a member-visible
-- table; tests/rls/model_usage.test.ts instead proves the negative: no real
-- signed-in client (including an anonymous-signin one) can reach either
-- table directly or call either function, through the real PostgREST path.
-- This file is the only place that can call reserve_model_call/
-- settle_model_call at all, acting as service_role via `set local role`
-- (never the actual admin/service-role HTTP credential -- this is a raw SQL
-- session already connected as postgres, a local superuser).
--
-- pg_temp does not persist across the separate psql connections pg_prove
-- opens per file (see 030's header), so every helper below is redefined
-- here even though some are verbatim copies of 010/020/030's.
--
-- Day-boundary approach (spec ambiguity worth documenting): now() cannot be
-- frozen inside a transaction -- reserve_model_call's SQL body calls
-- `now()` directly, which always resolves to pg_catalog.now() regardless of
-- this session's search_path (the function sets search_path = ''), so there
-- is no way to make the real function believe it is a different calendar
-- date. Two complementary checks are used instead:
--   (a) a real behavioural test against the actual function, using rows
--       whose created_at is set *relative to* the formula's own computed
--       Berlin-day start (now, minus/plus 30 minutes) -- this exercises the
--       real function on whatever actual date the suite happens to run on
--       (today, 2026-10-18, is CEST);
--   (b) a pure formula-correctness check that reproduces the migration's
--       exact boundary expression (`date_trunc('day', now() at time zone
--       'Europe/Berlin') at time zone 'Europe/Berlin'`) verbatim, fed
--       literal timestamps instead of now(), for one explicit CET date
--       (January) and one explicit CEST date (July) -- proving the formula
--       itself uses the Berlin offset (not a fixed +01/+02, not UTC) on
--       both sides of the DST transition, independent of what day it is
--       when the suite runs.

begin;

select plan(146);

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

-- Runs `probe` as `actor_id` under role authenticated, with a real-looking
-- (non-anonymous) JWT. Used for the FK-referential-action fixtures (deleting
-- one's own message, deleting a notebook one owns).
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

-- Same shape as act_lives, but stays as postgres (so an explicit `id` and
-- `user_id` can be set directly) -- used only to build fixtures, never to
-- prove an access-control decision.
create function pg_temp.setup_insert(actor_id uuid, probe text, description text) returns text as $$
declare
  ok_flag boolean := true;
  err_text text := '';
begin
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
  if ok_flag then
    return ok(true, description);
  else
    return ok(false, description || ' [errored: ' || err_text || ']');
  end if;
end;
$$ language plpgsql;

-- Runs `probe` as the current role (postgres): plain DDL/DML setup and
-- verification against private.usage/private.model_settings, which deny
-- everyone else outright. Reports a thrown error as a pgTAP FAIL instead of
-- aborting the transaction -- needed pre-migration, when these tables/
-- functions do not exist yet (42P01/42883 instead of a crashed script).
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

-- service_role-acting variants: reserve_model_call/settle_model_call are
-- SECURITY INVOKER, callable only by service_role (server code under
-- lib/server/admin/), never through a user's own JWT -- so every call below
-- goes through `set local role service_role`, not request.jwt.claims.

create function pg_temp.svc_lives(probe text, description text) returns text as $$
declare
  ok_flag boolean := true;
  err_text text := '';
begin
  set local role service_role;
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

create function pg_temp.svc_scalar(probe text) returns text as $$
declare
  result text;
  err_state text;
begin
  set local role service_role;
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

-- Like sql_throws, but as service_role: asserts the probe raises exactly
-- `expected_sqlstate` (used for the column-limited INSERT behaviour, item A).
create function pg_temp.svc_throws(probe text, expected_sqlstate text, description text) returns text as $$
declare
  actual_sqlstate text := null;
begin
  set local role service_role;
  begin
    execute probe;
  exception when others then
    get stacked diagnostics actual_sqlstate = returned_sqlstate;
  end;
  reset role;
  return is(actual_sqlstate, expected_sqlstate, description);
end;
$$ language plpgsql;

-- Like svc_throws, but accepts any sqlstate at all -- used for the
-- update-guard trigger (item B) and the repeatable-read isolation guard
-- (item C, in 041), where the spec only requires "it raises", not a specific
-- code.
create function pg_temp.svc_raises(probe text, description text) returns text as $$
declare
  raised boolean := false;
begin
  set local role service_role;
  begin
    execute probe;
  exception when others then
    raised := true;
  end;
  reset role;
  return ok(raised, description);
end;
$$ language plpgsql;

-- reserve_model_call returns TABLE(outcome text, usage_id uuid) -- a single
-- row every time (even the kill_switch_on/budget_exceeded cases, per spec).
-- Captures usage_id via a side-channel GUC (same mechanism 020's
-- act_insert_id uses) so a second, separate statement can read it back
-- without ever calling reserve_model_call a second time (which would be a
-- second, real reservation against the budget).
create function pg_temp.svc_reserve(probe text) returns text as $$
declare
  v_outcome text;
  v_usage_id uuid;
  err_state text;
begin
  set local role service_role;
  begin
    execute probe into v_outcome, v_usage_id;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate;
    v_outcome := 'ERROR:' || err_state;
    v_usage_id := null;
  end;
  reset role;
  perform set_config('pgtap_fixture.last_usage_id', coalesce(v_usage_id::text, ''), false);
  return v_outcome;
end;
$$ language plpgsql;

-- Builds the dynamic SQL text for a reserve_model_call probe. A plain
-- `language sql` function returning a formatted string, so it is safe to
-- create unconditionally (nothing here is validated against the real
-- catalog -- see 020's header on `language sql` vs `language plpgsql` body
-- validation).
create function pg_temp.reserve_probe(
  p_user uuid, p_anon boolean, p_notebook uuid, p_kind text, p_model text, p_est numeric, p_count int
) returns text as $$
  select format(
    'select outcome, usage_id from public.reserve_model_call(%L::uuid, %L::boolean, %L::uuid, %L::text, %L::text, %L::numeric, %L::int)',
    p_user, p_anon, p_notebook, p_kind, p_model, p_est, p_count
  );
$$ language sql;

create function pg_temp.settle_probe(
  p_id uuid, p_status text, p_in int, p_out int, p_cost numeric, p_lat int, p_msg uuid, p_err text
) returns text as $$
  select format(
    'select public.settle_model_call(%L::uuid, %L::text, %L::int, %L::int, %L::numeric, %L::int, %L::uuid, %L::text)::text',
    p_id, p_status, p_in, p_out, p_cost, p_lat, p_msg, p_err
  );
$$ language sql;

-- ---------------------------------------------------------------------------
-- Fixture users (reused across the whole file; fresh per scenario where
-- budget isolation matters).
-- ---------------------------------------------------------------------------

create table pg_temp.fixture (
  owner_a uuid not null,
  stranger_id uuid not null,
  budget_user uuid not null,
  anon_budget_user uuid not null,
  global_user_1 uuid not null,
  global_user_2 uuid not null,
  global_user_3 uuid not null,
  precedence_user uuid not null,
  reserved_counts_user uuid not null,
  failed_counts_user uuid not null,
  day_boundary_user uuid not null,
  settle_user uuid not null,
  fk_message_user uuid not null,
  fk_notebook_user uuid not null,
  fk_auth_user uuid not null,
  fk_message_notebook uuid not null,
  fk_message_id uuid not null,
  fk_notebook_notebook uuid not null,
  -- Reviewer-requested additions: column-limited INSERT (A), the
  -- reserved-\>settled|failed update-guard trigger (B), the three
  -- previously-vacuous "inserts no row" kill-switch sites (gap 1), null
  -- p_is_anonymous (gap 2a), and the settle_model_call validation/failed-path
  -- cases (gap 2c/d/e) each get their own dedicated, never-reused-elsewhere
  -- user so a before/after row count unambiguously isolates that one scenario.
  insert_limit_user uuid not null,
  trigger_guard_user uuid not null,
  trigger_guard_id uuid not null,
  ks_off_1_user uuid not null,
  ks_off_2_user uuid not null,
  ks_missing_settings_user uuid not null,
  null_anon_limit_user uuid not null,
  settle_neg_cost_user uuid not null,
  settle_null_cost_user uuid not null,
  settle_failed_user uuid not null,
  settle_error_category_user uuid not null,
  -- Reviewer round 2 (item 2): a dedicated user owning a notebook with two
  -- messages, used to prove the update-guard trigger also blocks rewriting
  -- message_id to a *different* non-null message on a settled/failed row
  -- (as opposed to item B's status-transition cases above).
  msg_guard_user uuid not null,
  msg_guard_notebook uuid not null,
  msg_guard_message_a uuid not null,
  msg_guard_message_b uuid not null,
  msg_guard_usage_id uuid not null
);
insert into pg_temp.fixture (
  owner_a, stranger_id, budget_user, anon_budget_user,
  global_user_1, global_user_2, global_user_3, precedence_user,
  reserved_counts_user, failed_counts_user, day_boundary_user, settle_user,
  fk_message_user, fk_notebook_user, fk_auth_user,
  fk_message_notebook, fk_message_id, fk_notebook_notebook,
  insert_limit_user, trigger_guard_user, trigger_guard_id,
  ks_off_1_user, ks_off_2_user, ks_missing_settings_user, null_anon_limit_user,
  settle_neg_cost_user, settle_null_cost_user, settle_failed_user, settle_error_category_user,
  msg_guard_user, msg_guard_notebook, msg_guard_message_a, msg_guard_message_b, msg_guard_usage_id
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (
  select unnest(array[
    owner_a, stranger_id, budget_user, anon_budget_user,
    global_user_1, global_user_2, global_user_3, precedence_user,
    reserved_counts_user, failed_counts_user, day_boundary_user, settle_user,
    fk_message_user, fk_notebook_user, fk_auth_user,
    insert_limit_user, trigger_guard_user,
    ks_off_1_user, ks_off_2_user, ks_missing_settings_user, null_anon_limit_user,
    settle_neg_cost_user, settle_null_cost_user, settle_failed_user, settle_error_category_user,
    msg_guard_user
  ]) as u
  from pg_temp.fixture
) as users;

-- fk_message_user owns a notebook and a message in it (for the message-FK
-- scenario); fk_notebook_user owns a separate notebook (for the notebook-FK
-- scenario). fk_auth_user owns nothing else at all (standalone, for the
-- auth.users-FK scenario, so deleting it has no collateral cascade).
select pg_temp.act_lives(
  (select fk_message_user from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select fk_message_notebook from pg_temp.fixture), 'usage fk message fixture'),
  'fixture setup: fk_message_user creates a notebook'
);
select pg_temp.setup_insert(
  (select fk_message_user from pg_temp.fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'user', 'fk fixture message') $f$,
    (select fk_message_id from pg_temp.fixture), (select fk_message_notebook from pg_temp.fixture)
  ),
  'fixture setup: fk_message_user inserts a message in that notebook'
);
select pg_temp.act_lives(
  (select fk_notebook_user from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select fk_notebook_notebook from pg_temp.fixture), 'usage fk notebook fixture'),
  'fixture setup: fk_notebook_user creates a notebook'
);

-- Reviewer round 2 (item 2): msg_guard_user owns a notebook with two
-- messages, used later to prove the update-guard trigger also blocks
-- rewriting message_id to a *different* non-null message on a settled row.
select pg_temp.act_lives(
  (select msg_guard_user from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)',
    (select msg_guard_notebook from pg_temp.fixture), 'usage message-guard fixture'),
  'fixture setup: msg_guard_user creates a notebook'
);
select pg_temp.setup_insert(
  (select msg_guard_user from pg_temp.fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'user', 'message-guard fixture a') $f$,
    (select msg_guard_message_a from pg_temp.fixture), (select msg_guard_notebook from pg_temp.fixture)
  ),
  'fixture setup: msg_guard_user inserts message_a in that notebook'
);
select pg_temp.setup_insert(
  (select msg_guard_user from pg_temp.fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'user', 'message-guard fixture b') $f$,
    (select msg_guard_message_b from pg_temp.fixture), (select msg_guard_notebook from pg_temp.fixture)
  ),
  'fixture setup: msg_guard_user inserts message_b in that notebook'
);

-- ---------------------------------------------------------------------------
-- 1) Existence, RLS, policies, grants, columns, seed row, function shapes
--    (checked before any behavioural scenario mutates the singleton row)
-- ---------------------------------------------------------------------------

select ok(to_regclass('private.usage') is not null, 'private.usage exists');
select ok(to_regclass('private.model_settings') is not null, 'private.model_settings exists');

select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'private' and c.relname = 'usage'), false),
  'RLS is enabled on private.usage'
);
select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'private' and c.relname = 'model_settings'), false),
  'RLS is enabled on private.model_settings'
);

select is_empty(
  $sql$
    select p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname in ('usage', 'model_settings')
      and p.polcmd = '*'
  $sql$,
  'no FOR ALL policy exists on private.usage or private.model_settings'
);

create function pg_temp.has_deny_policy(tbl text, cmd text) returns boolean as $$
  select exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = tbl
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

select ok(pg_temp.has_deny_policy('usage', 'r'), 'private.usage has a deny-all select policy (using (false))');
select ok(pg_temp.has_deny_policy('usage', 'a'), 'private.usage has a deny-all insert policy (with check (false))');
select ok(pg_temp.has_deny_policy('usage', 'w'), 'private.usage has a deny-all update policy (using/with check (false))');
select ok(pg_temp.has_deny_policy('usage', 'd'), 'private.usage has a deny-all delete policy (using (false))');
select ok(pg_temp.has_deny_policy('model_settings', 'r'), 'private.model_settings has a deny-all select policy');
select ok(pg_temp.has_deny_policy('model_settings', 'a'), 'private.model_settings has a deny-all insert policy');
select ok(pg_temp.has_deny_policy('model_settings', 'w'), 'private.model_settings has a deny-all update policy');
select ok(pg_temp.has_deny_policy('model_settings', 'd'), 'private.model_settings has a deny-all delete policy');

-- Grants: public (the PUBLIC pseudo-role), anon and authenticated have
-- nothing at all on either table.
create function pg_temp.no_privilege_at_all(role_name text, tbl text) returns boolean as $$
  select not (
    coalesce(has_table_privilege(role_name, to_regclass('private.' || tbl),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'), false)
    or coalesce(has_any_column_privilege(role_name, to_regclass('private.' || tbl), 'SELECT,INSERT,UPDATE,REFERENCES'), false)
  );
$$ language sql;

select ok(pg_temp.no_privilege_at_all('public', 'usage'), 'PUBLIC has no privilege on private.usage');
select ok(pg_temp.no_privilege_at_all('anon', 'usage'), 'anon has no privilege on private.usage');
select ok(pg_temp.no_privilege_at_all('authenticated', 'usage'), 'authenticated has no privilege on private.usage');
select ok(pg_temp.no_privilege_at_all('public', 'model_settings'), 'PUBLIC has no privilege on private.model_settings');
select ok(pg_temp.no_privilege_at_all('anon', 'model_settings'), 'anon has no privilege on private.model_settings');
select ok(pg_temp.no_privilege_at_all('authenticated', 'model_settings'), 'authenticated has no privilege on private.model_settings');

-- Grants: service_role's exact shape.
select ok(
  coalesce(has_schema_privilege('service_role', 'private', 'USAGE'), false),
  'service_role has USAGE on schema private'
);
select ok(
  coalesce(has_table_privilege('service_role', to_regclass('private.usage'), 'SELECT'), false),
  'service_role has SELECT on private.usage'
);
-- Item A narrowed this to a column-limited grant (exactly the six columns
-- checked further down), so unlike SELECT there is no unrestricted
-- table-level INSERT any more -- same shape as the table-level UPDATE check
-- just below, mirrored for INSERT instead of asserting a bare table-level
-- INSERT that item A's migration deliberately no longer grants.
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('private.usage'), 'INSERT'), false),
  'service_role has no table-level INSERT on private.usage (column-level only, see the six-column check below)'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('private.usage'), 'DELETE'), false),
  'service_role has no DELETE on private.usage'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('private.usage'), 'UPDATE'), false),
  'service_role has no table-level UPDATE on private.usage (column-level only)'
);
select ok(
  coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'status', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'input_tokens', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'output_tokens', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'cost_usd', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'latency_ms', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'message_id', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'error_category', 'UPDATE'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'settled_at', 'UPDATE'), false),
  'service_role can update status, input_tokens, output_tokens, cost_usd, latency_ms, message_id, error_category, settled_at'
);
select ok(
  not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'id', 'UPDATE'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'user_id', 'UPDATE'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'notebook_id', 'UPDATE'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'kind', 'UPDATE'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'model_id', 'UPDATE'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'call_count', 'UPDATE'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'created_at', 'UPDATE'), false),
  'service_role cannot update id, user_id, notebook_id, kind, model_id, call_count or created_at'
);

-- Reviewer finding (item A): INSERT on private.usage is column-limited to
-- exactly (user_id, notebook_id, kind, model_id, call_count, cost_usd) --
-- these catalog-level grant checks prove the ACL shape; the behavioural
-- section below proves Postgres actually enforces it on a real INSERT.
select ok(
  coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'user_id', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'notebook_id', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'kind', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'model_id', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'call_count', 'INSERT'), false)
  and coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'cost_usd', 'INSERT'), false),
  'service_role can insert user_id, notebook_id, kind, model_id, call_count, cost_usd'
);
select ok(
  not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'id', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'message_id', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'status', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'input_tokens', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'output_tokens', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'latency_ms', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'error_category', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'created_at', 'INSERT'), false)
  and not coalesce(has_column_privilege('service_role', to_regclass('private.usage'), 'settled_at', 'INSERT'), false),
  'service_role cannot insert id, message_id, status, input_tokens, output_tokens, latency_ms, error_category, created_at or settled_at'
);

select ok(
  coalesce(has_table_privilege('service_role', to_regclass('private.model_settings'), 'SELECT'), false),
  'service_role has SELECT on private.model_settings'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('private.model_settings'), 'INSERT'), false),
  'service_role has no INSERT on private.model_settings'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('private.model_settings'), 'UPDATE'), false)
  and not coalesce(has_any_column_privilege('service_role', to_regclass('private.model_settings'), 'UPDATE'), false),
  'service_role has no UPDATE on private.model_settings'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('private.model_settings'), 'DELETE'), false),
  'service_role has no DELETE on private.model_settings'
);

-- Reviewer finding (gap 4, catalog-style, added here rather than in
-- 000_catalog.test.sql per the review): service_role's entire privilege
-- footprint across schema `private` -- every table, column, sequence and
-- function, not just usage/model_settings -- is exactly: USAGE on the
-- schema; SELECT on model_settings; SELECT plus the documented 6-column
-- INSERT list and 8-column UPDATE list on usage; and nothing else at all --
-- no EXECUTE on any function in private (Postgres never requires an
-- explicit EXECUTE grant for a trigger to fire, so the update-guard trigger
-- from item B needs none, and this assertion is how "none" is actually
-- checked), no privilege on any other table (e.g. private.membership_audit),
-- and no CREATE on the schema itself. This is expected to fail today too,
-- independent of items A-D, for a simple reason: today's INSERT grant on
-- private.usage is still the broader, non-column-limited one item A narrows.
create function pg_temp.check_service_role_private_privileges() returns setof text as $$
  with rels as (
    select c.oid, n.nspname, c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  ),
  allowed_insert_cols as (
    select unnest(array['user_id', 'notebook_id', 'kind', 'model_id', 'call_count', 'cost_usd']) as col
  ),
  allowed_update_cols as (
    select unnest(array[
      'status', 'input_tokens', 'output_tokens', 'cost_usd', 'latency_ms',
      'message_id', 'error_category', 'settled_at'
    ]) as col
  ),
  -- Postgres does not guarantee AND/OR short-circuit evaluation order, so
  -- `relkind = 'S' and has_sequence_privilege(...)` in one WHERE clause can
  -- still evaluate has_sequence_privilege on a non-sequence row and raise
  -- "... is not a sequence" (confirmed the hard way here, same as
  -- 000_catalog.test.sql's check_anon_privileges documents) -- every
  -- relkind-conditional privilege function below goes through CASE WHEN
  -- instead, which Postgres does guarantee short-circuits.
  table_violations as (
    select nspname || '.' || relname || ':table:' || priv as sig
    from rels
    cross join lateral unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]) as priv
    where case when relkind <> 'S' then has_table_privilege('service_role', oid, priv) end
      and not (relname = 'model_settings' and priv = 'SELECT')
      and not (relname = 'usage' and priv = 'SELECT')
      -- Ops page (090_ops.test.sql): the one later addition. service_role reads private.eval_runs.
      and not (relname = 'eval_runs' and priv = 'SELECT')
  ),
  column_violations as (
    select nspname || '.' || relname || '.' || a.attname || ':' || priv as sig
    from rels
    join pg_attribute a on a.attrelid = oid and a.attnum > 0 and not a.attisdropped
    cross join lateral unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as priv
    where case when relkind <> 'S' then has_column_privilege('service_role', oid, a.attname, priv) end
      and not (priv = 'SELECT' and relname in ('usage', 'model_settings', 'eval_runs'))
      -- Ops page: record_eval_run inserts exactly these seven columns as service_role; 090 pins
      -- that nothing else (id, update, delete) is granted.
      and not (relname = 'eval_runs' and priv = 'INSERT' and a.attname in (
        'commit_sha', 'security_passed', 'security_total', 'quality_passed', 'quality_total', 'errored', 'ok'))
      and not (relname = 'usage' and priv = 'INSERT' and a.attname in (select col from allowed_insert_cols))
      and not (relname = 'usage' and priv = 'UPDATE' and a.attname in (select col from allowed_update_cols))
  ),
  sequence_violations as (
    select nspname || '.' || relname || ':sequence' as sig
    from rels
    where case when relkind = 'S' then has_sequence_privilege('service_role', oid, 'USAGE,SELECT,UPDATE') end
  ),
  function_violations as (
    select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
      )
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ),
  schema_violations as (
    select 'private:CREATE' as sig
    where has_schema_privilege('service_role', 'private', 'CREATE')
  )
  select sig from table_violations
  union all select sig from column_violations
  union all select sig from sequence_violations
  union all select sig from function_violations
  union all select sig from schema_violations;
$$ language sql;

select is_empty(
  'select * from pg_temp.check_service_role_private_privileges()',
  'service_role has no privilege anywhere in schema private beyond: USAGE on the schema, SELECT on model_settings, ' ||
  'SELECT plus the documented 6-column INSERT and 8-column UPDATE lists on usage, and no EXECUTE on any private function'
);

-- Exact column shapes.
select columns_are('private', 'usage', array[
  'id', 'user_id', 'notebook_id', 'message_id', 'kind', 'model_id', 'status',
  'call_count', 'input_tokens', 'output_tokens', 'cost_usd', 'latency_ms',
  'error_category', 'created_at', 'settled_at'
]);
select columns_are('private', 'model_settings', array[
  'id', 'model_features_enabled', 'daily_limit_usd', 'daily_limit_anonymous_usd',
  'global_daily_limit_usd', 'updated_at', 'updated_by', 'reason'
]);

-- Seed row: exact values, seeded disabled.
select pg_temp.safe_ok(
  $sql$
    select model_features_enabled = false
       and daily_limit_usd = 0.50
       and daily_limit_anonymous_usd = 0.20
       and global_daily_limit_usd = 5.00
       and updated_by = 'migration'
    from private.model_settings where id = true
  $sql$,
  'the seed row has the exact documented values'
);
select pg_temp.safe_ok(
  $sql$ select model_features_enabled = false from private.model_settings where id = true $sql$,
  'the seed row is seeded disabled (model_features_enabled = false)'
);
select pg_temp.safe_ok(
  $sql$ select count(*) = 1 from private.model_settings $sql$,
  'private.model_settings has exactly one row (the singleton)'
);

-- Function shapes: reserve_model_call, settle_model_call.
create function pg_temp.reserve_oid() returns oid as $$
  select to_regprocedure('public.reserve_model_call(uuid,boolean,uuid,text,text,numeric,integer)');
$$ language sql;
create function pg_temp.settle_oid() returns oid as $$
  select to_regprocedure('public.settle_model_call(uuid,text,integer,integer,numeric,integer,uuid,text)');
$$ language sql;

select ok(pg_temp.reserve_oid() is not null, 'public.reserve_model_call(uuid,boolean,uuid,text,text,numeric,integer) exists');
select ok(pg_temp.settle_oid() is not null, 'public.settle_model_call(uuid,text,integer,integer,numeric,integer,uuid,text) exists');

select ok(
  not coalesce((select prosecdef from pg_proc where oid = pg_temp.reserve_oid()), true),
  'reserve_model_call is security invoker (not security definer)'
);
select ok(
  not coalesce((select prosecdef from pg_proc where oid = pg_temp.settle_oid()), true),
  'settle_model_call is security invoker (not security definer)'
);
select ok(
  coalesce((select proconfig = array['search_path=""'] from pg_proc where oid = pg_temp.reserve_oid()), false),
  'reserve_model_call''s proconfig is exactly {search_path=""}'
);
select ok(
  coalesce((select proconfig = array['search_path=""'] from pg_proc where oid = pg_temp.settle_oid()), false),
  'settle_model_call''s proconfig is exactly {search_path=""}'
);
select ok(
  coalesce((select l.lanname = 'plpgsql' from pg_proc p join pg_language l on l.oid = p.prolang
            where p.oid = pg_temp.reserve_oid()), false),
  'reserve_model_call is language plpgsql'
);
select ok(
  coalesce((select l.lanname = 'plpgsql' from pg_proc p join pg_language l on l.oid = p.prolang
            where p.oid = pg_temp.settle_oid()), false),
  'settle_model_call is language plpgsql'
);
select ok(
  coalesce(has_function_privilege('service_role', pg_temp.reserve_oid(), 'EXECUTE'), false),
  'service_role can execute reserve_model_call'
);
select ok(
  coalesce(has_function_privilege('service_role', pg_temp.settle_oid(), 'EXECUTE'), false),
  'service_role can execute settle_model_call'
);
select ok(
  not coalesce(has_function_privilege('public', pg_temp.reserve_oid(), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('anon', pg_temp.reserve_oid(), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('authenticated', pg_temp.reserve_oid(), 'EXECUTE'), false),
  'reserve_model_call is not executable by PUBLIC, anon or authenticated'
);
select ok(
  not coalesce(has_function_privilege('public', pg_temp.settle_oid(), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('anon', pg_temp.settle_oid(), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('authenticated', pg_temp.settle_oid(), 'EXECUTE'), false),
  'settle_model_call is not executable by PUBLIC, anon or authenticated'
);

-- The SECURITY DEFINER allowlist (verbatim from 000_catalog.test.sql, not
-- edited there) stays exactly as it is -- neither new function is SECURITY
-- DEFINER, so neither should ever show up here.
create function pg_temp.check_security_definer_allowlist() returns setof text as $$
  with allowed_trigger_procs as (
    select unnest(array[
      to_regprocedure('private.add_notebook_owner()'),
      to_regprocedure('private.audit_membership()'),
      to_regprocedure('private.guard_last_owner()'),
      to_regprocedure('private.redact_cited_answers()'),
      -- F1 demo login trigger function, allowlisted by ADR 0012 (null-safe until the migration exists)
      to_regprocedure('private.copy_demo_template()')
    ]) as proc
  ),
  allowed as (
    select to_regprocedure('private.notebook_role(uuid)') as proc
    union all
    select proc from allowed_trigger_procs
  ),
  candidates as (
    select p.oid,
           n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
      )
  )
  select sig from candidates
  where oid::regprocedure not in (select proc from allowed where proc is not null);
$$ language sql;

select is_empty(
  'select * from pg_temp.check_security_definer_allowlist()',
  'the SECURITY DEFINER allowlist is unchanged: neither reserve_model_call nor settle_model_call is SECURITY DEFINER'
);

-- ---------------------------------------------------------------------------
-- 1b) Reviewer finding (item A): INSERT on private.usage is column-limited.
-- A direct INSERT as service_role succeeds with exactly the six allowed
-- columns and fails with 42501 the moment any other column is also set --
-- the catalog-level grant checks above prove the ACL shape, this proves
-- Postgres actually enforces it on a real write.
-- ---------------------------------------------------------------------------

select pg_temp.svc_lives(
  format(
    $f$ insert into private.usage (user_id, notebook_id, kind, model_id, call_count, cost_usd)
        values (%L, null, 'chat', 'test-model', 1, 0.01) $f$,
    (select insert_limit_user from pg_temp.fixture)
  ),
  'service_role can insert a row using only the six allowed columns (user_id, notebook_id, kind, model_id, call_count, cost_usd)'
);
select pg_temp.svc_throws(
  format(
    $f$ insert into private.usage (user_id, notebook_id, kind, model_id, call_count, cost_usd, status)
        values (%L, null, 'chat', 'test-model', 1, 0.01, 'settled') $f$,
    (select insert_limit_user from pg_temp.fixture)
  ),
  '42501',
  'service_role cannot insert while also setting status (42501)'
);
select pg_temp.svc_throws(
  format(
    $f$ insert into private.usage (user_id, notebook_id, kind, model_id, call_count, cost_usd, created_at)
        values (%L, null, 'chat', 'test-model', 1, 0.01, now()) $f$,
    (select insert_limit_user from pg_temp.fixture)
  ),
  '42501',
  'service_role cannot insert while also setting created_at (42501)'
);
select pg_temp.svc_throws(
  format(
    $f$ insert into private.usage (user_id, notebook_id, kind, model_id, call_count, cost_usd, settled_at)
        values (%L, null, 'chat', 'test-model', 1, 0.01, now()) $f$,
    (select insert_limit_user from pg_temp.fixture)
  ),
  '42501',
  'service_role cannot insert while also setting settled_at (42501)'
);
select pg_temp.safe_ok(
  format(
    $sql$ select count(*) = 1 from private.usage where user_id = %L $sql$,
    (select insert_limit_user from pg_temp.fixture)
  ),
  'exactly one row exists for insert_limit_user: only the allowed-columns insert succeeded, the three disallowed-column attempts inserted nothing'
);

-- ---------------------------------------------------------------------------
-- 2) Behaviour: kill switch and budget arithmetic
-- ---------------------------------------------------------------------------

-- Kill switch off (the seeded default): reserve returns kill_switch_on, no
-- row is inserted. Checked with a dedicated, never-reused-elsewhere user and
-- a real before/after count (the previous version of this check compared
-- private.usage.id against nullif(..., '') -- which is NULL whenever no row
-- was ever captured, so `id::text = NULL` is never true and the assertion
-- passed vacuously no matter what reserve_model_call actually did).
select pg_temp.safe_ok(
  format($sql$ select count(*) = 0 from private.usage where user_id = %L $sql$, (select ks_off_1_user from pg_temp.fixture)),
  'kill_switch_on (pre-check): no usage row exists yet for the dedicated ks_off_1_user'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select ks_off_1_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.10, 1
  )),
  'kill_switch_on',
  'kill switch off (seeded default): reserve_model_call returns kill_switch_on'
);
select pg_temp.safe_ok(
  format($sql$ select count(*) = 0 from private.usage where user_id = %L $sql$, (select ks_off_1_user from pg_temp.fixture)),
  'kill_switch_on inserts no row (ks_off_1_user''s row count is still 0 after the call)'
);

-- Enable the switch with the documented default limits.
select pg_temp.sql_lives(
  $sql$ update private.model_settings set model_features_enabled = true,
          daily_limit_usd = 0.50, daily_limit_anonymous_usd = 0.20, global_daily_limit_usd = 5.00
        where id = true $sql$,
  'setup: enable the kill switch with the default limits'
);

-- Within limit, then exactly at the limit, then over.
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.10, 1
  )),
  'ok',
  'budget_user: a 0.10 reservation within the 0.50 limit is ok'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.40, 1
  )),
  'ok',
  'budget_user: a further 0.40 reservation (sum exactly 0.50) is ok (exactly reaching the limit is allowed)'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.01, 1
  )),
  'budget_exceeded',
  'budget_user: a further 0.01 reservation (sum would be 0.51) is budget_exceeded'
);
select pg_temp.safe_ok(
  $sql$
    select coalesce(sum(cost_usd), 0) = 0.50 from private.usage
    where user_id = (select budget_user from pg_temp.fixture)
  $sql$,
  'budget_user has exactly 0.50 of reserved cost after the rejected reservation (no row for it)'
);

-- Anonymous limit (0.20), independent of the higher signed-in limit.
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select anon_budget_user from pg_temp.fixture), true, null, 'chat', 'test-model', 0.20, 1
  )),
  'ok',
  'anon_budget_user: a 0.20 reservation exactly at the anonymous limit is ok'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select anon_budget_user from pg_temp.fixture), true, null, 'chat', 'test-model', 0.01, 1
  )),
  'budget_exceeded',
  'anon_budget_user: a further 0.01 reservation (sum 0.21) is budget_exceeded (the anonymous limit, not 0.50)'
);

-- Reviewer finding (gap 2a): a null p_is_anonymous is treated as anonymous
-- (the tighter 0.20 limit), not as the higher 0.50 signed-in limit.
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select null_anon_limit_user from pg_temp.fixture), null, null, 'chat', 'test-model', 0.20, 1
  )),
  'ok',
  'null p_is_anonymous: a 0.20 reservation exactly at the anonymous limit is ok (null is treated as anonymous)'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select null_anon_limit_user from pg_temp.fixture), null, null, 'chat', 'test-model', 0.01, 1
  )),
  'budget_exceeded',
  'null p_is_anonymous: a further 0.01 reservation (sum 0.21) is budget_exceeded against the anonymous limit, not the higher signed-in one'
);

-- Global cap: three users, each individually well under their own 0.50
-- limit, but the global sum exceeds a lowered global cap. The cap is set
-- relative to whatever the fixtures above (budget_user, anon_budget_user)
-- have already reserved today -- reserve_model_call sums every row since the
-- Berlin day start, not just this scenario's own rows, so pinning the cap to
-- a hardcoded absolute value would make this scenario's outcome depend on
-- how much every earlier scenario in this file happened to reserve. Reading
-- the current sum and adding exactly 1.00 reproduces the original intent
-- (room for two 0.40 reservations, not a third) independent of that.
select pg_temp.sql_lives(
  $sql$
    update private.model_settings set global_daily_limit_usd = (
      select coalesce(sum(cost_usd), 0) from private.usage
      where created_at >= (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
    ) + 1.00
    where id = true
  $sql$,
  'setup: lower the global cap to (today''s current global sum + 1.00) for the global-cap scenario'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select global_user_1 from pg_temp.fixture), false, null, 'chat', 'test-model', 0.40, 1
  )),
  'ok',
  'global cap: global_user_1 reserves 0.40 (comfortably within the +1.00 headroom, under both limits)'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select global_user_2 from pg_temp.fixture), false, null, 'chat', 'test-model', 0.40, 1
  )),
  'ok',
  'global cap: global_user_2 reserves 0.40 (global sum now exactly at the +0.80 mark, still under the +1.00 cap)'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select global_user_3 from pg_temp.fixture), false, null, 'chat', 'test-model', 0.40, 1
  )),
  'global_budget_exceeded',
  'global cap: global_user_3''s own sum (0.40) is well under their 0.50 limit, but the global sum (+1.20 over today''s starting point) exceeds the +1.00 cap'
);
select pg_temp.safe_ok(
  $sql$
    select not exists (
      select 1 from private.usage where user_id = (select global_user_3 from pg_temp.fixture)
    )
  $sql$,
  'global_user_3''s rejected reservation inserted no row'
);

-- Precedence: when both the user''s own limit and the global cap are already
-- exceeded, the outcome is budget_exceeded (user-level checked first).
select pg_temp.sql_lives(
  $sql$ update private.model_settings set global_daily_limit_usd = 0.01 where id = true $sql$,
  'setup: drop the global cap to 0.01, already exceeded by the global-cap scenario above'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select precedence_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.60, 1
  )),
  'budget_exceeded',
  'precedence: an estimate that exceeds both the user''s own limit and the already-exceeded global cap reports budget_exceeded, not global_budget_exceeded'
);
select pg_temp.safe_ok(
  $sql$
    select not exists (
      select 1 from private.usage where user_id = (select precedence_user from pg_temp.fixture)
    )
  $sql$,
  'the precedence scenario''s rejected reservation inserted no row'
);

-- Reserved and failed rows both count toward the sums, not just settled ones.
select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage (user_id, kind, model_id, status, cost_usd)
        values (%L, 'chat', 'test-model', 'reserved', 0.30) $f$,
    (select reserved_counts_user from pg_temp.fixture)
  ),
  'setup: a pre-existing reserved row of 0.30 for reserved_counts_user'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select reserved_counts_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.25, 1
  )),
  'budget_exceeded',
  'a pre-existing reserved row counts toward the sum (0.30 + 0.25 > 0.50)'
);

select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage (user_id, kind, model_id, status, cost_usd, input_tokens, output_tokens, latency_ms, settled_at)
        values (%L, 'chat', 'test-model', 'failed', 0.30, 10, 0, 50, now()) $f$,
    (select failed_counts_user from pg_temp.fixture)
  ),
  'setup: a pre-existing failed row of 0.30 for failed_counts_user'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select failed_counts_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.25, 1
  )),
  'budget_exceeded',
  'a pre-existing failed row counts toward the sum (0.30 + 0.25 > 0.50)'
);

-- Kill switch off again: budget is irrelevant, always kill_switch_on, no row.
-- Reviewer finding (gap 1): a real before/after count for a dedicated user,
-- not just the outcome string.
select pg_temp.sql_lives(
  $sql$ update private.model_settings set model_features_enabled = false where id = true $sql$,
  'setup: disable the kill switch again'
);
select pg_temp.safe_ok(
  format($sql$ select count(*) = 0 from private.usage where user_id = %L $sql$, (select ks_off_2_user from pg_temp.fixture)),
  'switch off again (pre-check): no usage row exists yet for the dedicated ks_off_2_user'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select ks_off_2_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.01, 1
  )),
  'kill_switch_on',
  'switch off again: reserve_model_call returns kill_switch_on regardless of remaining budget'
);
select pg_temp.safe_ok(
  format($sql$ select count(*) = 0 from private.usage where user_id = %L $sql$, (select ks_off_2_user from pg_temp.fixture)),
  'switch off again inserts no row (ks_off_2_user''s row count is still 0 after the call)'
);

-- Missing settings row entirely: also kill_switch_on. Restored immediately
-- after, with the switch re-enabled and limits reset to the documented
-- defaults, so every later scenario in this file has a usable row again.
-- Reviewer finding (gap 1): same before/after count treatment, dedicated user.
select pg_temp.sql_lives(
  $sql$ delete from private.model_settings where id = true $sql$,
  'setup: delete the model_settings row entirely'
);
select pg_temp.safe_ok(
  format($sql$ select count(*) = 0 from private.usage where user_id = %L $sql$, (select ks_missing_settings_user from pg_temp.fixture)),
  'missing settings row (pre-check): no usage row exists yet for the dedicated ks_missing_settings_user'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select ks_missing_settings_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.01, 1
  )),
  'kill_switch_on',
  'a missing model_settings row: reserve_model_call returns kill_switch_on'
);
select pg_temp.safe_ok(
  format($sql$ select count(*) = 0 from private.usage where user_id = %L $sql$, (select ks_missing_settings_user from pg_temp.fixture)),
  'a missing model_settings row inserts no row (ks_missing_settings_user''s row count is still 0 after the call)'
);
-- The per-user/per-anonymous limits are restored to the exact documented
-- defaults (0.50/0.20), which every remaining per-user scenario in this file
-- stays well within. global_daily_limit_usd is deliberately restored to a
-- large value, not the documented 5.00 default: reserve_model_call sums
-- every usage row for the whole Berlin day, across every user, and this file
-- goes on to create many more real rows after this point (the update-guard
-- trigger fixture, the settle scenarios' reservations, gap 2c/d/e's
-- reservations, the day-boundary rows) -- a low global cap here would make
-- an unrelated later scenario fail with global_budget_exceeded instead of
-- the outcome it actually means to test, exactly as the global-cap section
-- above already had to account for with the *earlier* fixtures' sum. Nothing
-- below this point is testing the global cap itself (that is only the
-- dedicated global-cap/precedence scenarios above), so removing it as a
-- variable here is correct, not a workaround.
select pg_temp.sql_lives(
  $sql$ insert into private.model_settings
          (id, model_features_enabled, daily_limit_usd, daily_limit_anonymous_usd, global_daily_limit_usd, updated_by)
        values (true, true, 0.50, 0.20, 9999.99, 'pgtap-restore') $sql$,
  'setup: restore the model_settings row (enabled, default per-user/per-anonymous limits, a large global limit so later scenarios are not accidentally gated by it) for the remaining scenarios'
);

-- Validation: raises on null user, non-positive estimate, call_count < 1,
-- unknown kind. Reviewer round 2 (item 4): every one of these is now pinned
-- to the exact sqlstate 22023 (invalid_parameter_value), not just "any
-- error" -- a validation raise that happened to land on the wrong code (e.g.
-- a stray not-null violation instead of the function's own explicit check)
-- would otherwise pass silently.
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(null, false, null, 'chat', 'test-model', 0.10, 1)),
  'ERROR:22023',
  'reserve_model_call raises 22023 on a null p_user_id'
);
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0, 1
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 on p_estimated_cost_usd = 0'
);
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', -0.01, 1
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 on a negative p_estimated_cost_usd'
);
-- Reviewer finding (item D): an estimate that rounds to 0 at 12 decimals
-- (e.g. 1e-13) is effectively zero and must be rejected the same way as a
-- literal 0.
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', 1e-13, 1
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 when p_estimated_cost_usd rounds to 0 at 12 decimals (1e-13)'
);
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.10, 0
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 on p_call_count = 0'
);
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'bogus-kind', 'test-model', 0.10, 1
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 on an unknown p_kind'
);
-- Reviewer finding (gap 2b): p_model_id is required and length-bounded.
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', null, 0.10, 1
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 on a null p_model_id'
);
select is(
  pg_temp.svc_scalar(pg_temp.reserve_probe(
    (select budget_user from pg_temp.fixture), false, null, 'chat', repeat('x', 201), 0.10, 1
  )),
  'ERROR:22023',
  'reserve_model_call raises 22023 on a p_model_id over 200 characters (201 chars)'
);

-- ---------------------------------------------------------------------------
-- 2b) Reviewer finding (item B): a BEFORE UPDATE trigger on private.usage
-- (security invoker, in private) allows only reserved -> settled|failed.
-- Rewriting an already-settled row's cost_usd, or reverting its status back
-- to reserved, must raise (any errcode) and leave the row unchanged, even as
-- service_role, which otherwise has column-level UPDATE on exactly these
-- columns per the grant-shape checks above -- this proves the trigger
-- enforces a transition rule the column grant alone cannot express.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage
          (id, user_id, kind, model_id, call_count, cost_usd, status, input_tokens, output_tokens, latency_ms, settled_at)
        values (%L, %L, 'chat', 'test-model', 1, 0.02, 'settled', 5, 5, 10, now()) $f$,
    (select trigger_guard_id from pg_temp.fixture), (select trigger_guard_user from pg_temp.fixture)
  ),
  'setup: a settled row for the update-guard trigger scenario'
);
select pg_temp.svc_raises(
  format(
    $f$ update private.usage set cost_usd = 9.99 where id = %L $f$,
    (select trigger_guard_id from pg_temp.fixture)
  ),
  'service_role rewriting cost_usd on an already-settled row raises (the update-guard trigger only allows reserved -> settled|failed)'
);
select pg_temp.safe_ok(
  format(
    $sql$ select cost_usd = 0.02 and status = 'settled' from private.usage where id = %L $sql$,
    (select trigger_guard_id from pg_temp.fixture)
  ),
  'the settled row is unchanged after the rejected cost_usd rewrite'
);
select pg_temp.svc_raises(
  format(
    $f$ update private.usage set status = 'reserved' where id = %L $f$,
    (select trigger_guard_id from pg_temp.fixture)
  ),
  'service_role setting status back to reserved on a settled row raises'
);
select pg_temp.safe_ok(
  format(
    $sql$ select status = 'settled' from private.usage where id = %L $sql$,
    (select trigger_guard_id from pg_temp.fixture)
  ),
  'the row is still settled after the rejected status-reversion update'
);

-- ---------------------------------------------------------------------------
-- 2c) Reviewer round 2 finding (item 2): the update-guard trigger also blocks
-- rewriting message_id on a settled (or failed) row to a *different*,
-- non-null message -- only a transition to message_id = null (the FK's own
-- ON DELETE SET NULL action, exercised in section 5 below) is meant to stay
-- allowed. This is new behaviour the builder has not added yet, so it is
-- expected to be the only red case in this file.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage
          (id, user_id, message_id, kind, model_id, call_count, cost_usd, status, input_tokens, output_tokens, latency_ms, settled_at)
        values (%L, %L, %L, 'chat', 'test-model', 1, 0.03, 'settled', 5, 5, 10, now()) $f$,
    (select msg_guard_usage_id from pg_temp.fixture),
    (select msg_guard_user from pg_temp.fixture),
    (select msg_guard_message_a from pg_temp.fixture)
  ),
  'setup: a settled usage row referencing msg_guard_message_a'
);
select pg_temp.svc_throws(
  format(
    $f$ update private.usage set message_id = %L where id = %L $f$,
    (select msg_guard_message_b from pg_temp.fixture),
    (select msg_guard_usage_id from pg_temp.fixture)
  ),
  '55000',
  'service_role rewriting message_id on a settled row to a different non-null message raises 55000'
);
select pg_temp.safe_ok(
  format(
    $sql$ select message_id = %L and cost_usd = 0.03 and status = 'settled' from private.usage where id = %L $sql$,
    (select msg_guard_message_a from pg_temp.fixture), (select msg_guard_usage_id from pg_temp.fixture)
  ),
  'the row is unchanged after the rejected message_id rewrite (still references message_a, cost_usd and status untouched)'
);

-- ---------------------------------------------------------------------------
-- 3) Europe/Berlin day boundary
-- ---------------------------------------------------------------------------

-- (a) Behavioural: a row just before today's Berlin midnight does not count,
-- a row just after it does -- using the formula's own computed boundary, so
-- this holds on whatever actual date the suite runs on (see file header).
create table pg_temp.day_boundary (day_start timestamptz);
insert into pg_temp.day_boundary
select date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';

select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage
          (user_id, kind, model_id, status, cost_usd, input_tokens, output_tokens, latency_ms, settled_at, created_at)
        values (%L, 'chat', 'test-model', 'settled', 0.45, 10, 10, 50, %L::timestamptz, %L::timestamptz)
    $f$,
    (select day_boundary_user from pg_temp.fixture),
    (select day_start - interval '30 minutes' from pg_temp.day_boundary),
    (select day_start - interval '30 minutes' from pg_temp.day_boundary)
  ),
  'setup: a 0.45 settled row just before today''s Berlin midnight (yesterday 23:30 Berlin)'
);
select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage
          (user_id, kind, model_id, status, cost_usd, input_tokens, output_tokens, latency_ms, settled_at, created_at)
        values (%L, 'chat', 'test-model', 'settled', 0.04, 10, 10, 50, %L::timestamptz, %L::timestamptz)
    $f$,
    (select day_boundary_user from pg_temp.fixture),
    (select day_start + interval '30 minutes' from pg_temp.day_boundary),
    (select day_start + interval '30 minutes' from pg_temp.day_boundary)
  ),
  'setup: a 0.04 settled row just after today''s Berlin midnight (today 00:30 Berlin)'
);

select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select day_boundary_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.04, 1
  )),
  'ok',
  'day boundary: only today''s 0.04 row counts (0.04 + 0.04 = 0.08 <= 0.50) -- yesterday''s 0.45 is excluded'
);

-- (b) Formula correctness: the migration's exact boundary expression,
-- reproduced verbatim, fed literal timestamps for one CET date (January)
-- and one CEST date (July).
select ok(
  (date_trunc('day', timestamptz '2026-01-15 23:30:00+01' at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
    = timestamptz '2026-01-15 00:00:00+01',
  'CET: 23:30 Berlin on 2026-01-15 falls in the 2026-01-15 Berlin day (boundary at 00:00+01)'
);
select ok(
  (date_trunc('day', timestamptz '2026-01-16 00:30:00+01' at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
    = timestamptz '2026-01-16 00:00:00+01',
  'CET: 00:30 Berlin on 2026-01-16 falls in the 2026-01-16 Berlin day, not the 15th'
);
select ok(
  (date_trunc('day', timestamptz '2026-07-15 23:30:00+02' at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
    = timestamptz '2026-07-15 00:00:00+02',
  'CEST: 23:30 Berlin on 2026-07-15 falls in the 2026-07-15 Berlin day (boundary at 00:00+02)'
);
select ok(
  (date_trunc('day', timestamptz '2026-07-16 00:30:00+02' at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
    = timestamptz '2026-07-16 00:00:00+02',
  'CEST: 00:30 Berlin on 2026-07-16 falls in the 2026-07-16 Berlin day, not the 15th'
);

-- ---------------------------------------------------------------------------
-- 4) settle_model_call
-- ---------------------------------------------------------------------------

-- `perform`, not a bare `select`, so this reservation's own outcome (which is
-- 'ok' here) never reaches psql's output: pgTAP's test runner reads every
-- line of stdout as TAP, and a line that is literally the word "ok" (no test
-- number) is valid bare TAP syntax that a parser auto-numbers as the next
-- test in sequence -- silently shifting every later assertion's number and
-- inflating the total count. The side effect (inserting the reserved row,
-- setting the pgtap_fixture.last_usage_id GUC) still happens the same way.
do $do$ begin
  perform pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.05, 1
  ));
end $do$;
select pg_temp.sql_lives(
  $sql$ select set_config('pgtap_fixture.settle_usage_id', current_setting('pgtap_fixture.last_usage_id', true), false) $sql$,
  'capture the reserved usage_id for the settle scenario'
);

select is(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_usage_id', true), '')::uuid),
    'settled', 120, 80, 0.045, 900, null, null
  )),
  'true',
  'settle_model_call on a reserved row returns true'
);
select pg_temp.safe_ok(
  format(
    $f$ select status = 'settled' and settled_at is not null and input_tokens = 120
          and output_tokens = 80 and cost_usd = 0.045 and latency_ms = 900
        from private.usage where id = %L
    $f$,
    (select nullif(current_setting('pgtap_fixture.settle_usage_id', true), '')::uuid)
  ),
  'the settled row has the supplied status, tokens, cost and latency, and settled_at is set'
);

-- Second settle is idempotent: returns false, changes nothing.
select is(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_usage_id', true), '')::uuid),
    'failed', 1, 1, 9.99, 1, null, 'should_not_apply'
  )),
  'false',
  'a second settle on an already-settled row returns false'
);
select pg_temp.safe_ok(
  format(
    $f$ select status = 'settled' and input_tokens = 120 and output_tokens = 80 and cost_usd = 0.045 and latency_ms = 900
        from private.usage where id = %L
    $f$,
    (select nullif(current_setting('pgtap_fixture.settle_usage_id', true), '')::uuid)
  ),
  'the second (no-op) settle changed nothing'
);

-- Invalid p_status raises. Same `do`/`perform` reasoning as the settle
-- scenario's own reservation above: a bare `select` here would again print
-- an unnumbered "ok" line and desynchronize the TAP sequence.
do $do$ begin
  perform pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.01, 1
  ));
end $do$;
select pg_temp.sql_lives(
  $sql$ select set_config('pgtap_fixture.settle_usage_id_2', current_setting('pgtap_fixture.last_usage_id', true), false) $sql$,
  'capture a second reserved usage_id for the invalid-status scenario'
);
select ok(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_usage_id_2', true), '')::uuid),
    'reserved', 1, 1, 0.01, 1, null, null
  )) like 'ERROR:%',
  'settle_model_call raises when p_status is ''reserved'' (not settled or failed)'
);
select ok(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_usage_id_2', true), '')::uuid),
    'bogus', 1, 1, 0.01, 1, null, null
  )) like 'ERROR:%',
  'settle_model_call raises when p_status is an unrecognised value'
);

-- Reviewer finding (gap 2c): p_cost_usd must be non-negative and non-null.
do $do$ begin
  perform pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_neg_cost_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.05, 1
  ));
end $do$;
select pg_temp.sql_lives(
  $sql$ select set_config('pgtap_fixture.settle_neg_cost_usage_id', current_setting('pgtap_fixture.last_usage_id', true), false) $sql$,
  'capture the reserved usage_id for the negative-cost settle rejection scenario'
);
select is(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_neg_cost_usage_id', true), '')::uuid),
    'settled', 10, 10, -0.01, 50, null, null
  )),
  'ERROR:23514',
  'settle_model_call rejects a negative p_cost_usd with 23514'
);

do $do$ begin
  perform pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_null_cost_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.05, 1
  ));
end $do$;
select pg_temp.sql_lives(
  $sql$ select set_config('pgtap_fixture.settle_null_cost_usage_id', current_setting('pgtap_fixture.last_usage_id', true), false) $sql$,
  'capture the reserved usage_id for the null-cost settle rejection scenario'
);
select is(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_null_cost_usage_id', true), '')::uuid),
    'settled', 10, 10, null, 50, null, null
  )),
  'ERROR:23502',
  'settle_model_call rejects a null p_cost_usd with 23502'
);

-- Reviewer finding (gap 2d): the `failed` path (status failed, with an
-- error_category) is accepted, and the failed row's cost still counts toward
-- that user's running sum -- not just reserved/settled rows.
do $do$ begin
  perform pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_failed_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.15, 1
  ));
end $do$;
select pg_temp.sql_lives(
  $sql$ select set_config('pgtap_fixture.settle_failed_usage_id', current_setting('pgtap_fixture.last_usage_id', true), false) $sql$,
  'capture the reserved usage_id for the failed-settle scenario'
);
select is(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_failed_usage_id', true), '')::uuid),
    'failed', 5, 0, 0.15, 20, null, 'provider_error'
  )),
  'true',
  'settle_model_call on a reserved row accepts the failed path with an error_category'
);
select pg_temp.safe_ok(
  format(
    $f$ select status = 'failed' and error_category = 'provider_error' and cost_usd = 0.15
        from private.usage where id = %L
    $f$,
    (select nullif(current_setting('pgtap_fixture.settle_failed_usage_id', true), '')::uuid)
  ),
  'the failed row has the supplied status and error_category, and keeps its cost_usd'
);
select is(
  pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_failed_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.40, 1
  )),
  'budget_exceeded',
  'the settled-as-failed row''s cost (0.15) still counts toward settle_failed_user''s sum (0.15 + 0.40 > 0.50)'
);

-- Reviewer finding (gap 2e): error_category must match ^[a-z_]{1,40}$.
do $do$ begin
  perform pg_temp.svc_reserve(pg_temp.reserve_probe(
    (select settle_error_category_user from pg_temp.fixture), false, null, 'chat', 'test-model', 0.05, 1
  ));
end $do$;
select pg_temp.sql_lives(
  $sql$ select set_config('pgtap_fixture.settle_bad_category_usage_id', current_setting('pgtap_fixture.last_usage_id', true), false) $sql$,
  'capture the reserved usage_id for the invalid error_category scenario'
);
select ok(
  pg_temp.svc_scalar(pg_temp.settle_probe(
    (select nullif(current_setting('pgtap_fixture.settle_bad_category_usage_id', true), '')::uuid),
    'failed', 1, 1, 0.01, 1, null, 'Not Valid!'
  )) like 'ERROR:%',
  'settle_model_call rejects an error_category that does not match ^[a-z_]{1,40}$'
);

-- Check constraint: a non-reserved row with null tokens is rejected.
select pg_temp.sql_throws(
  format(
    $f$ insert into private.usage (user_id, kind, model_id, status, cost_usd, settled_at)
        values (%L, 'chat', 'test-model', 'settled', 0.01, now()) $f$,
    (select settle_user from pg_temp.fixture)
  ),
  '23514',
  'the check constraint rejects a settled row with null input_tokens/output_tokens/latency_ms'
);

-- ---------------------------------------------------------------------------
-- 5) Referential actions: ON DELETE SET NULL onto messages/notebooks/
--    auth.users, usage row survives with its cost intact
-- ---------------------------------------------------------------------------

-- Reviewer round 2 (item 1): this row is now *settled* (tokens, latency and
-- settled_at set), not merely reserved -- proving the FK's own ON DELETE SET
-- NULL action still works on a settled row despite item B's update-guard
-- trigger (which must keep allowing a transition to message_id = null; only
-- item 2 below's reassignment to a *different*, non-null message is meant to
-- be blocked).
select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage
          (id, user_id, notebook_id, message_id, kind, model_id, status, cost_usd, input_tokens, output_tokens, latency_ms, settled_at)
        values (%L, %L, %L, %L, 'chat', 'test-model', 'settled', 1.2345, 10, 10, 50, now()) $f$,
    (select fk_message_id from pg_temp.fixture),
    (select fk_message_user from pg_temp.fixture),
    (select fk_message_notebook from pg_temp.fixture),
    (select fk_message_id from pg_temp.fixture)
  ),
  'setup: a settled usage row referencing the fk-message fixture''s message, notebook and user'
);
-- Reuse the message id itself as the usage row''s own id: convenient unique
-- value already in scope, no bearing on the test.
select pg_temp.act_lives(
  (select fk_message_user from pg_temp.fixture),
  format('delete from public.messages where id = %L', (select fk_message_id from pg_temp.fixture)),
  'fk_message_user deletes their own message'
);
select pg_temp.safe_ok(
  format(
    $f$ select message_id is null and notebook_id = %L and cost_usd = 1.2345 and status = 'settled'
        from private.usage where id = %L $f$,
    (select fk_message_notebook from pg_temp.fixture), (select fk_message_id from pg_temp.fixture)
  ),
  'deleting the message sets usage.message_id to null and leaves notebook_id, cost_usd and status untouched'
);

select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage (user_id, notebook_id, kind, model_id, status, cost_usd)
        values (%L, %L, 'chat', 'test-model', 'reserved', 2.3456) $f$,
    (select fk_notebook_user from pg_temp.fixture), (select fk_notebook_notebook from pg_temp.fixture)
  ),
  'setup: a usage row referencing the fk-notebook fixture''s notebook and user'
);
select pg_temp.act_lives(
  (select fk_notebook_user from pg_temp.fixture),
  format('delete from public.notebooks where id = %L', (select fk_notebook_notebook from pg_temp.fixture)),
  'fk_notebook_user deletes their own notebook'
);
select pg_temp.safe_ok(
  format(
    $f$ select notebook_id is null and user_id = %L and cost_usd = 2.3456
        from private.usage where user_id = %L and cost_usd = 2.3456 $f$,
    (select fk_notebook_user from pg_temp.fixture), (select fk_notebook_user from pg_temp.fixture)
  ),
  'deleting the notebook sets usage.notebook_id to null and leaves user_id and cost_usd untouched'
);

select pg_temp.sql_lives(
  format(
    $f$ insert into private.usage (user_id, kind, model_id, status, cost_usd)
        values (%L, 'chat', 'test-model', 'reserved', 3.4567) $f$,
    (select fk_auth_user from pg_temp.fixture)
  ),
  'setup: a usage row referencing a standalone auth.users row'
);
select pg_temp.sql_lives(
  format('delete from auth.users where id = %L', (select fk_auth_user from pg_temp.fixture)),
  'postgres deletes the standalone auth.users row directly'
);
select pg_temp.safe_ok(
  $sql$ select user_id is null and cost_usd = 3.4567 from private.usage where cost_usd = 3.4567 $sql$,
  'deleting the auth.users row sets usage.user_id to null and leaves cost_usd untouched'
);

select * from finish();

rollback;
