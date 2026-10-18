-- Concurrency test for PR E1's advisory lock: reserve_model_call must
-- serialize concurrent reservations against the same budget so that a race
-- never lets more estimates through than the limit allows. 040's behavioural
-- suite proves the arithmetic sequentially, in one session; this file proves
-- it under real concurrency, using several separate Postgres backends.
--
-- pgTAP/pg_prove gives this file its own single session, so "several
-- backends" has to come from outside that session: `dblink` opens real,
-- independent connections to the same local database, each a genuine
-- separate backend with its own transaction, so statements sent through one
-- while another is in flight actually race for the same advisory lock
-- instead of just running sequentially inside one session's transaction.
--
-- Connection string, and why: Supabase's local pg_hba.conf trusts Unix-socket
-- and 127.0.0.1 connections only when no password is supplied and they
-- authenticate as the role already driving that connection -- dblink's
-- connections are new backends authenticating from scratch, so loopback
-- without a password (127.0.0.1, or the Unix socket) is rejected with
-- "password or GSSAPI delegated credentials required" (confirmed against
-- this local stack before settling on the approach below), and `postgres`
-- here is not a superuser that could bypass that. `host(inet_server_addr())`
-- -- not `inet_server_addr()::text`, which keeps the "/32" CIDR suffix and
-- makes libpq reject the host string outright -- resolves to this session's
-- own server address as seen from inside the database container's network,
-- where password auth is configured and the local default password
-- ("postgres", seeded by every `supabase start`, including CI) is accepted.
-- This is a local test credential, not a secret; nothing here is the
-- service_role HTTP credential, and no assertion below ever runs as the
-- literal service_role key -- only `set role service_role` inside a raw SQL
-- session already connected as postgres, exactly like 040.
begin;

select plan(21);
create extension if not exists dblink;

select ok(
  inet_server_addr() is not null,
  'inet_server_addr() is not null (required to build the dblink loopback connection string; ' ||
  'if this ever fails, report it -- do not invent another connection path)'
);

create function pg_temp.connstr() returns text as $$
  select format('host=%s port=5432 dbname=postgres user=postgres password=postgres', host(inet_server_addr()));
$$ language sql;

-- Eleven fixed, deterministic test users (n=0 for the single-user scenario,
-- n=1..10 for the ten-distinct-users scenario), so cleanup can target them by
-- literal id without having to discover what a previous run left behind.
create function pg_temp.fixed_user(n int) returns uuid as $$
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid;
$$ language sql immutable;

create function pg_temp.all_fixed_users() returns uuid[] as $$
  select array(select pg_temp.fixed_user(n) from generate_series(0, 10) as n);
$$ language sql immutable;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Runs `probe` as the current (local) role, tolerating any error -- same
-- shape as 040's pg_temp.sql_lives, redefined here since pg_temp does not
-- persist across the separate psql connections pg_prove opens per file.
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

-- One short-lived dblink connection (as postgres, never service_role) for
-- plain setup/cleanup statements: creating fixture users, changing
-- model_settings (service_role has no UPDATE on it -- see 040), deleting
-- committed rows. Opens, runs `stmts` in order, disconnects. Each statement
-- tolerates its target relation not existing yet (pre-migration), so this
-- stays usable both before and after the migration lands.
create function pg_temp.run_as_postgres(stmts text[]) returns void as $$
declare
  stmt text;
begin
  perform dblink_connect('setup', pg_temp.connstr());
  foreach stmt in array stmts loop
    begin
      perform dblink_exec('setup', stmt);
    exception when others then
      null; -- tolerate a missing relation/column pre-migration
    end;
  end loop;
  perform dblink_disconnect('setup');
end;
$$ language plpgsql;

create function pg_temp.insert_fixture_user_sql(n int) returns text as $$
  select format(
    $f$insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
       values (%L, %L, 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb)$f$,
    pg_temp.fixed_user(n), pg_temp.fixed_user(n)::text || '@example.test'
  );
$$ language sql;

-- Opens one dblink connection per name in `names`, each authenticating as
-- postgres (see the file header) and then switching to service_role for the
-- lifetime of that connection -- reserve_model_call is executable only by
-- service_role, exactly as 040 exercises it with `set local role`.
create function pg_temp.open_pool(names text[]) returns void as $$
declare
  nm text;
begin
  foreach nm in array names loop
    perform dblink_connect(nm, pg_temp.connstr());
    perform dblink_exec(nm, 'set role service_role');
  end loop;
end;
$$ language plpgsql;

create function pg_temp.close_pool(names text[]) returns void as $$
declare
  nm text;
begin
  foreach nm in array names loop
    begin
      perform dblink_disconnect(nm);
    exception when others then
      null; -- tolerate an already-closed/never-opened connection
    end;
  end loop;
end;
$$ language plpgsql;

-- Builds the reserve_model_call probe text, identical in shape to 040's
-- pg_temp.reserve_probe, for dispatch through dblink_send_query on a remote
-- connection (which cannot see this session's pg_temp functions, so the full
-- SQL text has to be self-contained).
create function pg_temp.reserve_sql(
  p_user uuid, p_anon boolean, p_notebook uuid, p_kind text, p_model text, p_est numeric, p_count int
) returns text as $$
  select format(
    'select outcome, usage_id from public.reserve_model_call(%L::uuid, %L::boolean, %L::uuid, %L::text, %L::text, %L::numeric, %L::int)',
    p_user, p_anon, p_notebook, p_kind, p_model, p_est, p_count
  );
$$ language sql;

-- Reviewer finding (gap 3): each reservation is sent as a single query
-- *string* containing two statements -- `select ... reserve_model_call(...);
-- select pg_sleep(0.2) is null as slept` -- not just the bare reserve call.
-- Postgres runs a multi-statement simple-query string as one implicit
-- transaction, so appending the sleep holds that whole transaction (and, if
-- reserve_model_call actually takes a transaction-scoped advisory lock,
-- *holds the lock*) open for 0.2s before it can commit. Without this, five
-- reservations dispatched "concurrently" could still happen to run and
-- commit one after another fast enough that each one's budget check already
-- sees the previous one's committed row -- the race the advisory lock exists
-- to prevent would then never actually occur, and the test could pass for
-- the wrong reason even with no lock in the implementation at all. With the
-- sleep, all five connections in a wave are still mid-transaction when the
-- next one starts, so without a real lock every one of them would read the
-- same stale sum and wrongly approve more reservations than the limit
-- allows; this makes the test fail deterministically, every run, if the lock
-- is missing, instead of only "sometimes" depending on scheduling luck.
-- `pg_sleep(...) is null` (not bare `pg_sleep(...)`, which returns `void` --
-- not a valid row/record column type for dblink_get_result's `as t(...)`
-- column list) always evaluates to a plain, declarable boolean.
create function pg_temp.reserve_and_hold_sql(
  p_user uuid, p_anon boolean, p_notebook uuid, p_kind text, p_model text, p_est numeric, p_count int
) returns text as $$
  select pg_temp.reserve_sql(p_user, p_anon, p_notebook, p_kind, p_model, p_est, p_count)
    || '; select pg_sleep(0.2) is null as slept';
$$ language sql;

-- Reads back the result of an async reserve_and_hold_sql query sent earlier
-- on `connname` via dblink_send_query. That query is two statements, so
-- there are two result sets to drain in order -- the reserve_model_call row
-- (outcome text, usage_id uuid), then the pg_sleep row (slept boolean) --
-- plus a final empty marker, each read with the column types matching that
-- specific result set (dblink_get_result needs them to match the real
-- columns, not just be castable to them); verified against this local stack
-- with a trivial two-statement two-cycle send/collect probe before writing
-- this function. Every drain step after the first is wrapped in its own
-- exception handler and ignored: if the first (reserve) statement already
-- errored (e.g. 42883 before the migration exists, or before item C's
-- isolation guard exists it never errors at all), Postgres aborts the rest
-- of that implicit transaction and the later result sets this function still
-- tries to read may simply not exist -- that is expected, not a new failure.
create function pg_temp.dblink_get_reserve(connname text) returns text as $$
declare
  rec record;
  found_row boolean := false;
  outcome_val text;
  err_state text;
begin
  begin
    for rec in select * from dblink_get_result(connname) as t(outcome text, usage_id uuid) loop
      outcome_val := rec.outcome;
      found_row := true;
    end loop;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate;
  end;

  -- Drain the pg_sleep statement's result set, if it ran at all.
  begin
    perform * from dblink_get_result(connname) as t2(slept boolean);
  exception when others then
    null;
  end;

  -- Always drain the final "no more results" marker, even when the query
  -- above errored -- otherwise the connection is left mid-command and the
  -- next wave's dblink_send_query on it silently fails with "another command
  -- is already in progress" instead of actually dispatching. An error here
  -- (nothing left to drain) is harmless and ignored.
  begin
    perform * from dblink_get_result(connname) as t3(slept boolean);
  exception when others then
    null;
  end;

  if err_state is not null then
    return 'ERROR:' || err_state;
  end if;
  if not found_row then
    return 'ERROR:NO_ROWS';
  end if;
  return outcome_val;
end;
$$ language plpgsql;

-- Fires one reserve_model_call (held open 0.2s by the appended pg_sleep, see
-- above) per uuid in `user_ids` (length 10 for both scenarios here), spread
-- across the five pooled connections in `conn_names`, reused across two
-- waves of five: all five in a wave are dispatched with dblink_send_query
-- before any of that wave's results are collected, so they genuinely race
-- for reserve_model_call's advisory lock instead of running one at a time.
create function pg_temp.fire_reservations(conn_names text[], user_ids uuid[], p_est numeric) returns text[] as $$
declare
  pool_size int := array_length(conn_names, 1);
  total int := array_length(user_ids, 1);
  outcomes text[] := array[]::text[];
  i int := 1;
  batch_size int;
  j int;
begin
  while i <= total loop
    batch_size := least(pool_size, total - i + 1);
    for j in 0 .. batch_size - 1 loop
      perform dblink_send_query(
        conn_names[j + 1],
        pg_temp.reserve_and_hold_sql(user_ids[i + j], false, null, 'chat', 'test-model', p_est, 1)
      );
    end loop;
    for j in 0 .. batch_size - 1 loop
      outcomes := outcomes || pg_temp.dblink_get_reserve(conn_names[j + 1]);
    end loop;
    i := i + batch_size;
  end loop;
  return outcomes;
end;
$$ language plpgsql;

-- Deletes every fixture row this file can create (usage rows and test
-- users) and restores private.model_settings to the exact documented seed,
-- all through a fresh dblink connection as postgres (never service_role,
-- which has no UPDATE on model_settings -- see 040). Every statement
-- tolerates the underlying relation not existing yet (pre-migration, via
-- run_as_postgres's per-statement exception handling), so this is safe to
-- call both before the real scenarios (an idempotent safety net against a
-- prior run that failed mid-way and left committed state behind) and after
-- them (real cleanup).
create function pg_temp.cleanup_fixtures() returns void as $$
  select pg_temp.run_as_postgres(array[
    format('delete from private.usage where user_id = any(%L::uuid[])', pg_temp.all_fixed_users()),
    format('delete from auth.users where id = any(%L::uuid[])', pg_temp.all_fixed_users()),
    $sql$ update private.model_settings set
            model_features_enabled = false,
            daily_limit_usd = 0.50,
            daily_limit_anonymous_usd = 0.20,
            global_daily_limit_usd = 5.00,
            updated_by = 'migration',
            reason = null
          where id = true $sql$
  ]);
$$ language sql;

-- Idempotent safety net: a previous run that died mid-scenario could have
-- left committed usage rows, test users or a modified model_settings row
-- behind (dblink statements commit immediately, independent of this
-- session's own rollback at the end of the file).
select pg_temp.sql_lives(
  'select pg_temp.cleanup_fixtures()',
  'pre-test cleanup via dblink succeeds (idempotent safety net for a prior failed run)'
);

-- ---------------------------------------------------------------------------
-- Scenario (a): ten concurrent reservations for one user, whose own daily
-- limit fits exactly three of the estimates used.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  $sql$ select pg_temp.run_as_postgres(array[pg_temp.insert_fixture_user_sql(0)]) $sql$,
  'setup: create the single-user scenario''s fixed test user in auth.users via dblink'
);

select pg_temp.sql_lives(
  $sql$ select pg_temp.run_as_postgres(array[
          'update private.model_settings set model_features_enabled = true, ' ||
          'daily_limit_usd = 0.30, daily_limit_anonymous_usd = 0.20, global_daily_limit_usd = 1000.00 where id = true'
        ]) $sql$,
  'setup: enable the kill switch and set a 0.30 per-user limit (exactly three 0.10 estimates) via dblink'
);

select pg_temp.sql_lives(
  $sql$ select pg_temp.open_pool(array['pool1', 'pool2', 'pool3', 'pool4', 'pool5']) $sql$,
  'setup: open 5 pooled dblink connections, each switched to service_role'
);

create table pg_temp.scenario_a_outcomes (outcome text);
insert into pg_temp.scenario_a_outcomes
select unnest(pg_temp.fire_reservations(
  array['pool1', 'pool2', 'pool3', 'pool4', 'pool5'],
  array_fill(pg_temp.fixed_user(0), array[10]),
  0.10
));

select is(
  (select count(*)::int from pg_temp.scenario_a_outcomes where outcome = 'ok'),
  3,
  'single user, 10 concurrent reservations of 0.10 against a 0.30 limit: exactly 3 return ok'
);
-- Reviewer finding (gap 3): the other 7 are specifically budget_exceeded
-- (the per-user limit), not errors or some other outcome -- a broken lock
-- could otherwise manifest as a deadlock, a stray exception, or the wrong
-- rejection reason instead of a clean over-limit count mismatch.
select is(
  (select count(*)::int from pg_temp.scenario_a_outcomes where outcome = 'budget_exceeded'),
  7,
  'single user, 10 concurrent reservations of 0.10 against a 0.30 limit: exactly 7 return budget_exceeded'
);
select is(
  (select count(*)::int from pg_temp.scenario_a_outcomes where outcome not in ('ok', 'budget_exceeded')),
  0,
  'single user, 10 concurrent reservations of 0.10 against a 0.30 limit: none of the 10 results is an error or any other outcome'
);
select pg_temp.safe_ok(
  format(
    $sql$ select coalesce(sum(cost_usd), 0) <= 0.30 from private.usage where user_id = %L $sql$,
    pg_temp.fixed_user(0)
  ),
  'the single user''s reserved sum never exceeds their 0.30 limit, even under concurrency'
);

select pg_temp.sql_lives(
  'select pg_temp.close_pool(array[''pool1'', ''pool2'', ''pool3'', ''pool4'', ''pool5''])',
  'teardown: close the pooled dblink connections after scenario (a)'
);

-- ---------------------------------------------------------------------------
-- Scenario (b): ten concurrent reservations from ten distinct users, each
-- comfortably under their own limit, racing against a global cap that fits
-- exactly three of the estimates used. Scenario (a)'s committed usage row is
-- removed first, so the global sum here starts at zero.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  format(
    $sql$ select pg_temp.run_as_postgres(array[
            format('delete from private.usage where user_id = %%L', %L::uuid),
            %L,
            %L,
            %L,
            %L,
            %L,
            %L,
            %L,
            %L,
            %L,
            %L,
            $u$update private.model_settings set daily_limit_usd = 5.00, global_daily_limit_usd = (
              select coalesce(sum(cost_usd), 0) from private.usage
              where created_at >= (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
            ) + 0.30 where id = true$u$
          ]) $sql$,
    pg_temp.fixed_user(0),
    pg_temp.insert_fixture_user_sql(1), pg_temp.insert_fixture_user_sql(2), pg_temp.insert_fixture_user_sql(3),
    pg_temp.insert_fixture_user_sql(4), pg_temp.insert_fixture_user_sql(5), pg_temp.insert_fixture_user_sql(6),
    pg_temp.insert_fixture_user_sql(7), pg_temp.insert_fixture_user_sql(8), pg_temp.insert_fixture_user_sql(9),
    pg_temp.insert_fixture_user_sql(10)
  ),
  'setup: remove scenario (a)''s usage row, create the ten distinct test users, and set a 0.30 global cap (each user''s own limit raised to 5.00) via dblink'
);

select pg_temp.sql_lives(
  $sql$ select pg_temp.open_pool(array['pool1', 'pool2', 'pool3', 'pool4', 'pool5']) $sql$,
  'setup: reopen 5 pooled dblink connections, each switched to service_role, for scenario (b)'
);

create table pg_temp.scenario_b_outcomes (outcome text);
insert into pg_temp.scenario_b_outcomes
select unnest(pg_temp.fire_reservations(
  array['pool1', 'pool2', 'pool3', 'pool4', 'pool5'],
  array(select pg_temp.fixed_user(n) from generate_series(1, 10) as n),
  0.10
));

select is(
  (select count(*)::int from pg_temp.scenario_b_outcomes where outcome = 'ok'),
  3,
  'ten distinct users (each well under their own 5.00 limit), 10 concurrent reservations of 0.10 against a 0.30 global cap: exactly 3 return ok'
);
-- Reviewer finding (gap 3): the other 7 are specifically global_budget_exceeded.
select is(
  (select count(*)::int from pg_temp.scenario_b_outcomes where outcome = 'global_budget_exceeded'),
  7,
  'ten distinct users, 10 concurrent reservations of 0.10 against a 0.30 global cap: exactly 7 return global_budget_exceeded'
);
select is(
  (select count(*)::int from pg_temp.scenario_b_outcomes where outcome not in ('ok', 'global_budget_exceeded')),
  0,
  'ten distinct users, 10 concurrent reservations of 0.10 against a 0.30 global cap: none of the 10 results is an error or any other outcome'
);
select pg_temp.safe_ok(
  format(
    $sql$ select coalesce(sum(cost_usd), 0) <= 0.30 from private.usage where user_id = any(%L::uuid[]) $sql$,
    (select array(select pg_temp.fixed_user(n) from generate_series(1, 10) as n))
  ),
  'the global reserved sum across all ten users never exceeds the 0.30 global cap, even under concurrency'
);

select pg_temp.sql_lives(
  'select pg_temp.close_pool(array[''pool1'', ''pool2'', ''pool3'', ''pool4'', ''pool5''])',
  'teardown: close the pooled dblink connections after scenario (b)'
);

-- ---------------------------------------------------------------------------
-- Scenario (c): reviewer finding, item C. reserve_model_call must raise when
-- called inside a REPEATABLE READ transaction: its budget check reads a live
-- aggregate over private.usage that has to see other sessions' concurrent
-- commits for the advisory lock above to mean anything -- REPEATABLE READ's
-- snapshot isolation would silently freeze that aggregate at transaction
-- start instead, defeating the lock without ever raising an error, unless
-- reserve_model_call itself checks current_setting('transaction_isolation')
-- and refuses to run under anything but READ COMMITTED.
--
-- This cannot be tested from 040's own transaction: `set transaction
-- isolation level` only takes effect before any statement has run in a
-- transaction, and 040's single transaction has already executed many
-- statements by the time this would matter. It needs a genuinely fresh
-- transaction on a fresh connection, which only dblink provides here --
-- fixed_user(0) (still present in auth.users from scenario (a); only its
-- usage row was removed before scenario (b)) and generous limits (so the
-- only possible reason to be refused is the isolation guard itself, not an
-- ordinary budget rejection) are reused for it.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  $sql$ select pg_temp.run_as_postgres(array[
          'update private.model_settings set model_features_enabled = true, ' ||
          'daily_limit_usd = 1000.00, daily_limit_anonymous_usd = 1000.00, global_daily_limit_usd = 1000.00 where id = true'
        ]) $sql$,
  'setup: enable the kill switch with generous limits for the isolation-level scenario'
);

create function pg_temp.repeatable_read_probe() returns text as $$
declare
  err_state text;
  err_msg text;
begin
  perform dblink_connect('iso', pg_temp.connstr());
  perform dblink_exec('iso', 'set role service_role');
  perform dblink_exec('iso', 'begin isolation level repeatable read');
  -- dblink_exec refuses any statement that returns a result set ("statement
  -- returning results not allowed"), and reserve_model_call's probe is a
  -- SELECT -- send_query/get_result (the same pair the pooled-connection
  -- reservations above use) is the right tool here, not dblink_exec.
  begin
    perform dblink_send_query('iso', format(
      'select outcome, usage_id from public.reserve_model_call(%L::uuid, false, null, ''chat'', ''test-model'', 0.01, 1)',
      pg_temp.fixed_user(0)
    ));
    perform * from dblink_get_result('iso') as t(outcome text, usage_id uuid);
    perform * from dblink_get_result('iso') as t2(outcome text, usage_id uuid);
    err_state := null;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate, err_msg = message_text;
  end;
  begin
    perform dblink_exec('iso', 'rollback');
  exception when others then
    null;
  end;
  perform dblink_disconnect('iso');
  return coalesce(err_state || ': ' || err_msg, 'NO_ERROR');
end;
$$ language plpgsql;

-- Reviewer round 2 (item 3): pinned to the exact sqlstate 25001, not just
-- "any error" -- the probe formats its result as '<sqlstate>: <message>'.
select ok(
  pg_temp.repeatable_read_probe() like '25001:%',
  'reserve_model_call raises exactly 25001 when called inside a repeatable read transaction (item C)'
);

-- ---------------------------------------------------------------------------
-- Final cleanup: delete every committed fixture row and restore the seed
-- settings row exactly, so a later run of this file (or 040, which asserts
-- the seed values itself) starts clean.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives('select pg_temp.cleanup_fixtures()', 'final cleanup via dblink succeeds (usage rows and test users removed, settings restored)');
select pg_temp.safe_ok(
  $sql$
    select model_features_enabled = false
       and daily_limit_usd = 0.50
       and daily_limit_anonymous_usd = 0.20
       and global_daily_limit_usd = 5.00
       and updated_by = 'migration'
    from private.model_settings where id = true
  $sql$,
  'the model_settings row is restored to the exact documented seed values after cleanup'
);

select * from finish();
rollback;
