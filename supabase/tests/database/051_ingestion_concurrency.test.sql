-- Concurrency test for PR C1's private.enforce_notebook_chunk_limit()
-- trigger: the AFTER INSERT FOR EACH STATEMENT trigger takes a
-- pg_advisory_xact_lock before counting public.chunks for a notebook, so a
-- race at the 20,000-row boundary must still let through at most one more
-- row than the limit allows, never both. 050_ingestion.test.sql proves the
-- cap sequentially, in one session; this file proves it under real
-- concurrency, using separate Postgres backends -- following
-- 041_model_usage_concurrency.test.sql's dblink pattern exactly, since a
-- single pg_prove session cannot otherwise produce two genuinely concurrent
-- backends racing for the same advisory lock.
--
-- Connection string, and why: see 041's header -- local pg_hba.conf trusts
-- unix-socket/127.0.0.1 connections only when no password is supplied and
-- they authenticate as the role already driving that connection, so
-- dblink's fresh backends need `host(inet_server_addr())` with the local
-- default password ("postgres", seeded by every `supabase start`, including
-- CI). Both racing connections stay as `postgres` (not `service_role`): the
-- chunk-limit trigger fires identically regardless of role (it bypasses RLS
-- the same way for any role with INSERT on public.chunks, and postgres has
-- that unconditionally as table owner) -- there is no privilege distinction
-- to exercise here the way 041's service_role switch exercises
-- reserve_model_call's own EXECUTE grant.
--
-- Setup/fixture rows are created through a short-lived dblink connection
-- (pg_temp.run_as_postgres, verbatim from 041) so they are genuinely
-- committed and visible to the two separate racing connections -- this
-- file's own `begin; ... rollback;` transaction would otherwise never be
-- visible to them at all (different backends, read-committed visibility).
-- Final cleanup runs the same way, so a run never leaves committed rows
-- behind for the next one.

begin;

select plan(9);
create extension if not exists dblink;

select ok(
  inet_server_addr() is not null,
  'inet_server_addr() is not null (required to build the dblink loopback connection string; ' ||
  'if this ever fails, report it -- do not invent another connection path)'
);

create function pg_temp.connstr() returns text as $$
  select format('host=%s port=5432 dbname=postgres user=postgres password=postgres', host(inet_server_addr()));
$$ language sql;

-- Fixed, deterministic fixture ids so cleanup can target them by literal id
-- without having to discover what a previous run left behind.
create function pg_temp.fixed_owner() returns uuid as $$
  select '00000000-0000-0000-0000-00000000c051'::uuid;
$$ language sql immutable;
create function pg_temp.fixed_notebook() returns uuid as $$
  select '00000000-0000-0000-0000-00000001c051'::uuid;
$$ language sql immutable;
create function pg_temp.fixed_source() returns uuid as $$
  select '00000000-0000-0000-0000-00000002c051'::uuid;
$$ language sql immutable;

-- ---------------------------------------------------------------------------
-- Helpers (verbatim shape from 041; redefined here since pg_temp does not
-- persist across the separate psql connections pg_prove opens per file)
-- ---------------------------------------------------------------------------

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

-- One short-lived dblink connection (as postgres) for plain setup/cleanup
-- statements, each tolerating its target relation/row not existing or
-- already existing (pre-migration, or a prior run's leftovers).
create function pg_temp.run_as_postgres(stmts text[]) returns void as $$
declare
  stmt text;
begin
  perform dblink_connect('setup', pg_temp.connstr());
  foreach stmt in array stmts loop
    begin
      perform dblink_exec('setup', stmt);
    exception when others then
      null;
    end;
  end loop;
  perform dblink_disconnect('setup');
end;
$$ language plpgsql;

create function pg_temp.open_pool(names text[]) returns void as $$
declare
  nm text;
begin
  foreach nm in array names loop
    perform dblink_connect(nm, pg_temp.connstr());
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
      null;
    end;
  end loop;
end;
$$ language plpgsql;

-- Builds one racing insert as a two-statement query string (the insert
-- itself, RETURNING id so there is a result set to read back, plus an
-- appended pg_sleep that holds the whole implicit transaction -- and
-- therefore the trigger's advisory lock, if the migration exists -- open for
-- 0.2s). Same "hold the transaction open so the two dispatches genuinely
-- overlap" reasoning as 041's reserve_and_hold_sql; without it, two
-- "concurrent" dispatches could still happen to commit one after another
-- fast enough that the race the lock exists to prevent never actually
-- occurs.
create function pg_temp.race_insert_sql(p_notebook uuid, p_source uuid, p_ordinal int) returns text as $$
  select format(
    $f$insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
       values (%L, %L, %L, 'race chunk', null, array_fill(0.01::real, array[1024])::extensions.vector)
       returning id$f$,
    p_notebook, p_source, p_ordinal
  ) || '; select pg_sleep(0.2) is null as slept';
$$ language sql;

-- Reads back the result of a race_insert_sql query sent earlier via
-- dblink_send_query: the insert's own result set (one uuid column), then the
-- pg_sleep result set, then the final "no more results" marker -- same
-- three-drain shape as 041's dblink_get_reserve, for the same reason (a
-- failed first statement aborts the rest of that implicit transaction, so
-- later result sets may simply not exist; that is expected, not a new
-- failure, and every drain after the first tolerates it).
create function pg_temp.dblink_get_race_outcome(connname text) returns text as $$
declare
  rec record;
  got_row boolean := false;
  err_state text;
begin
  begin
    for rec in select * from dblink_get_result(connname) as t(id uuid) loop
      got_row := true;
    end loop;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate;
  end;

  begin
    perform * from dblink_get_result(connname) as t2(slept boolean);
  exception when others then
    null;
  end;
  begin
    perform * from dblink_get_result(connname) as t3(slept boolean);
  exception when others then
    null;
  end;

  if err_state is not null then
    return 'ERROR:' || err_state;
  end if;
  if got_row then
    return 'ok';
  end if;
  return 'ERROR:NO_ROWS';
end;
$$ language plpgsql;

create function pg_temp.insert_fixture_owner_sql() returns text as $$
  select format(
    $f$insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
       values (%L, %L, 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb)$f$,
    pg_temp.fixed_owner(), pg_temp.fixed_owner()::text || '@example.test'
  );
$$ language sql;

-- Builds the whole setup statement array as a plain SQL function (not a
-- dynamic string nested inside another format() call): every element is its
-- own ordinary format() call evaluated once, bottom-up, by Postgres itself --
-- no double %%-escaping to get wrong, unlike building this same array as
-- text for sql_lives to EXECUTE.
create function pg_temp.setup_race_fixtures() returns void as $$
  select pg_temp.run_as_postgres(array[
    pg_temp.insert_fixture_owner_sql(),
    format(
      $f$select set_config('request.jwt.claims', %L, false)$f$,
      json_build_object('sub', pg_temp.fixed_owner(), 'role', 'authenticated', 'is_anonymous', false)::text
    ),
    format(
      $f$insert into public.notebooks (id, title) values (%L, %L)$f$,
      pg_temp.fixed_notebook(), 'ingestion concurrency notebook'
    ),
    format(
      $f$insert into public.sources (id, notebook_id, kind, title) values (%L, %L, %L, %L)$f$,
      pg_temp.fixed_source(), pg_temp.fixed_notebook(), 'text', 'concurrency source'
    ),
    format(
      $f$insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
         select %L, %L, gs, 'chunk ' || gs, null, array_fill(0.01::real, array[1024])::extensions.vector
         from generate_series(1, 19999) as gs$f$,
      pg_temp.fixed_notebook(), pg_temp.fixed_source()
    )
  ]);
$$ language sql;

create function pg_temp.cleanup_fixtures() returns void as $$
  select pg_temp.run_as_postgres(array[
    format('delete from public.chunks where notebook_id = %L', pg_temp.fixed_notebook()),
    format('delete from public.sources where notebook_id = %L', pg_temp.fixed_notebook()),
    format('delete from public.notebooks where id = %L', pg_temp.fixed_notebook()),
    format('delete from auth.users where id = %L', pg_temp.fixed_owner())
  ]);
$$ language sql;

-- Idempotent safety net: a previous run that died mid-scenario could have
-- left committed rows behind (dblink statements commit immediately,
-- independent of this session's own rollback at the end of the file).
select pg_temp.sql_lives(
  'select pg_temp.cleanup_fixtures()',
  'pre-test cleanup via dblink succeeds (idempotent safety net for a prior failed run)'
);

-- ---------------------------------------------------------------------------
-- Setup: a real notebook and source, with 19,999 chunks already committed --
-- one below the 20,000 cap, so the two racing single-row inserts below
-- together straddle the boundary.
-- ---------------------------------------------------------------------------

select pg_temp.sql_lives(
  'select pg_temp.setup_race_fixtures()',
  'setup: create the fixture owner, notebook, source and 19,999 committed chunks via dblink'
);

select pg_temp.sql_lives(
  $sql$ select pg_temp.open_pool(array['race1', 'race2']) $sql$,
  'setup: open 2 pooled dblink connections (as postgres)'
);

-- Dispatches both racing inserts before collecting either result (same
-- "send both, then collect both" shape as 041's fire_reservations), so the
-- two genuinely overlap instead of running one after the other; wrapped in
-- its own function (rather than bare top-level `select dblink_send_query(...)`
-- calls) so no stray result row ever reaches psql's output mid-TAP-stream.
create function pg_temp.fire_race() returns text[] as $$
begin
  perform dblink_send_query('race1', pg_temp.race_insert_sql(pg_temp.fixed_notebook(), pg_temp.fixed_source(), 20000));
  perform dblink_send_query('race2', pg_temp.race_insert_sql(pg_temp.fixed_notebook(), pg_temp.fixed_source(), 20001));
  return array[pg_temp.dblink_get_race_outcome('race1'), pg_temp.dblink_get_race_outcome('race2')];
end;
$$ language plpgsql;

create table pg_temp.race_outcomes (outcome text);
insert into pg_temp.race_outcomes (outcome)
select unnest(pg_temp.fire_race());

select is(
  (select count(*)::int from pg_temp.race_outcomes where outcome = 'ok'),
  1,
  'exactly one of the two concurrent chunk inserts at the 19,999/20,000 boundary succeeds'
);
select is(
  (select count(*)::int from pg_temp.race_outcomes where outcome = 'ERROR:54000'),
  1,
  'exactly one of the two concurrent chunk inserts fails with 54000 (notebook_chunk_limit)'
);

select pg_temp.safe_ok(
  format(
    $sql$ select count(*) = 20000 from public.chunks where notebook_id = %L $sql$,
    pg_temp.fixed_notebook()
  ),
  'the notebook ends at exactly 20,000 committed chunks, never 20,001'
);

select pg_temp.sql_lives(
  $sql$ select pg_temp.close_pool(array['race1', 'race2']) $sql$,
  'teardown: close the pooled dblink connections'
);

select pg_temp.sql_lives(
  'select pg_temp.cleanup_fixtures()',
  'final cleanup via dblink succeeds (fixture owner, notebook, source and chunks removed)'
);

select * from finish();
rollback;
