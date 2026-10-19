-- Catalog and behavioural tests for PR C1 (the `error_category`/
-- `status_changed_at` columns on public.sources, their constraints and
-- grants, and the three new trigger functions: private.touch_source_status(),
-- private.enforce_notebook_source_limit() and
-- private.enforce_notebook_chunk_limit()). 000_catalog.test.sql already
-- proves the general invariants every table/function must satisfy (RLS on,
-- no FOR ALL policy, SECURITY DEFINER allowlist, search_path, grants, ...) --
-- this file proves C1's own contract on top of that: the exact column
-- shapes and constraint names, the column-level grants, the three
-- functions' own properties (not SECURITY DEFINER, empty search_path, no
-- EXECUTE for authenticated), the triggers' exact timing/level, and the
-- behavioural effect of all three (status_changed_at touch, the two check
-- constraints, the 50-source cap and the 20,000-chunk cap, plus that a
-- sibling notebook is unaffected by either cap).
--
-- public.sources/public.chunks/public.notebooks already exist from earlier
-- migrations (20261017120000_notebooks_memberships.sql,
-- 20261018120000_sources_chunks_messages.sql), so -- unlike 020/030, which
-- had to guard against application tables/types not existing at all yet --
-- plain fixture DML against those tables (creating a notebook, a source) is
-- safe to run as ordinary top-level statements here: it cannot abort the
-- transaction before this migration lands, only before C1's *new* columns/
-- constraints/triggers exist, which is exactly what every behavioural probe
-- below is built to report as a clean pgTAP FAIL instead of a crash (via the
-- pg_temp.sql_lives/sql_throws/act_lives/act_throws/safe_ok helpers,
-- redefined here verbatim from 020/030/040/041 since pg_temp does not
-- persist across the separate psql connections pg_prove opens per file).
--
-- Fixture notebooks are created with a client-chosen id (needed so the
-- AFTER INSERT add_notebook_owner trigger's membership row exists before any
-- RETURNING select-policy check could run -- see
-- tests/rls/helpers/notebooks.ts's and 020/030's own comments on the same
-- race) via pg_temp.act_lives; fixture sources use the server-generated id,
-- captured via pg_temp.act_insert_id's RETURNING-into-GUC side channel, same
-- as 020/030.
--
-- The chunk-cap behaviour (50,000 rows would be slow and is not needed: the
-- cap is 20,000) is driven directly as `postgres` (pg_temp.sql_lives/
-- sql_throws, no role switch) rather than through the authenticated-role
-- act_* helpers: chunks carry no per-row membership concern of their own
-- (notebook_id/source_id are picked by the fixture, not by an actor), and
-- postgres already bypasses both RLS and the column-privilege grant that
-- would otherwise apply -- the trigger itself fires identically regardless
-- of role, which is the only thing this section is about. Concurrency for
-- the same trigger (two sessions racing at the boundary) is proven
-- separately in 051_ingestion_concurrency.test.sql, following 041's dblink
-- pattern, since this single pg_prove session cannot produce two genuinely
-- concurrent backends on its own.

begin;

select plan(50);

-- ---------------------------------------------------------------------------
-- Helpers (verbatim shape from 020/030/040/041; redefined here because
-- pg_temp does not persist across the separate psql connections pg_prove
-- opens per file)
-- ---------------------------------------------------------------------------

create function pg_temp.proc_oid(schema_name text, proc_name text) returns oid as $$
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = schema_name and p.proname = proc_name
  limit 1;
$$ language sql;

-- Runs `probe` as the current role (postgres), reporting a thrown error as a
-- pgTAP FAIL with the real message instead of aborting the transaction.
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

-- Same shape as sql_throws, but returns the raised message_text (or '' if
-- the probe did not error) instead of asserting a sqlstate -- used to check
-- an error's message content (e.g. "contains notebook_source_limit")
-- without a second, redundant throws-style assertion.
create function pg_temp.sql_error_message(probe text) returns text as $$
declare
  err_text text := '';
begin
  begin
    execute probe;
  exception when others then
    get stacked diagnostics err_text = message_text;
  end;
  return err_text;
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

-- Same shape as act_throws, but returns the message_text ('' if no error)
-- instead of asserting a sqlstate -- see sql_error_message above.
create function pg_temp.act_error_message(actor_id uuid, probe text) returns text as $$
declare
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
    get stacked diagnostics err_text = message_text;
  end;
  reset role;
  return err_text;
end;
$$ language plpgsql;

-- Same shape as act_lives, but `probe` is an "INSERT ... RETURNING id"
-- statement; the captured id goes out via a side-channel session GUC,
-- consumed by a plain follow-up statement -- see its call sites below.
create function pg_temp.act_insert_id(actor_id uuid, probe text, description text) returns text as $$
declare
  result uuid;
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
    execute probe into result;
  exception when others then
    ok_flag := false;
    get stacked diagnostics err_text = message_text;
  end;
  reset role;
  perform set_config('pgtap_fixture.last_inserted_id', coalesce(result::text, ''), false);
  if ok_flag then
    return ok(true, description);
  else
    return ok(false, description || ' [errored: ' || err_text || ']');
  end if;
end;
$$ language plpgsql;

-- Runs `probe` as `actor_id` under role authenticated, expected to return
-- exactly one text-castable scalar. On error, returns 'ERROR:<sqlstate>'
-- instead of raising, so the caller can assert on the scalar value either way.
create function pg_temp.act_scalar(actor_id uuid, probe text) returns text as $$
declare
  result text;
  err_state text;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated', 'is_anonymous', false)::text,
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

-- Runs `probe` (expected to return exactly one boolean-castable scalar),
-- tolerating any error (including a cast failure on an 'ERROR:...' string
-- produced by act_scalar/sql_scalar above) by defaulting to false -- same
-- shape as 020/040's pg_temp.safe_ok.
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

-- ---------------------------------------------------------------------------
-- 1) Column shapes and named constraints (pure catalog introspection, no
-- fixture rows needed)
-- ---------------------------------------------------------------------------

select ok(
  coalesce(
    (select t.typname = 'text' and not a.attnotnull
     from pg_attribute a
     join pg_type t on t.oid = a.atttypid
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and a.attname = 'error_category'
       and not a.attisdropped),
    false
  ),
  'sources.error_category is a nullable text column'
);

select ok(
  coalesce(
    (select t.typname = 'timestamptz' and a.attnotnull
     from pg_attribute a
     join pg_type t on t.oid = a.atttypid
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and a.attname = 'status_changed_at'
       and not a.attisdropped),
    false
  ),
  'sources.status_changed_at is a not-null timestamptz column'
);

select ok(
  coalesce(
    (select pg_get_expr(d.adbin, d.adrelid) ilike '%now%'
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     join pg_class c on c.oid = d.adrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and a.attname = 'status_changed_at'),
    false
  ),
  'sources.status_changed_at defaults to now()'
);

select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources' and con.contype = 'c'
      and con.conname = 'sources_error_category_format'
  ),
  'sources has a check constraint named sources_error_category_format'
);

select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources' and con.contype = 'c'
      and con.conname = 'sources_error_category_only_failed'
  ),
  'sources has a check constraint named sources_error_category_only_failed'
);

-- ---------------------------------------------------------------------------
-- 2) Column-level grants
-- ---------------------------------------------------------------------------

select ok(
  coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'error_category', 'UPDATE'), false),
  'authenticated has UPDATE on sources.error_category'
);
select ok(
  not coalesce(
    has_column_privilege('authenticated', to_regclass('public.sources'), 'status_changed_at', 'UPDATE'),
    false
  ),
  'authenticated has no UPDATE on sources.status_changed_at'
);

-- ---------------------------------------------------------------------------
-- 3) The three trigger functions: existence, not SECURITY DEFINER, empty
-- search_path, no EXECUTE for authenticated
-- ---------------------------------------------------------------------------

select ok(pg_temp.proc_oid('private', 'touch_source_status') is not null, 'private.touch_source_status() exists');
select ok(
  coalesce(
    (select not p.prosecdef from pg_proc p where p.oid = pg_temp.proc_oid('private', 'touch_source_status')),
    false
  ),
  'private.touch_source_status() is not SECURITY DEFINER'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(p.proconfig, '{}'))
     from pg_proc p where p.oid = pg_temp.proc_oid('private', 'touch_source_status')),
    false
  ),
  'private.touch_source_status() sets search_path to an exact empty string'
);
select ok(
  not coalesce(has_function_privilege('authenticated', pg_temp.proc_oid('private', 'touch_source_status'), 'EXECUTE'), false),
  'authenticated cannot execute private.touch_source_status()'
);

select ok(
  pg_temp.proc_oid('private', 'enforce_notebook_source_limit') is not null,
  'private.enforce_notebook_source_limit() exists'
);
select ok(
  coalesce(
    (select not p.prosecdef from pg_proc p where p.oid = pg_temp.proc_oid('private', 'enforce_notebook_source_limit')),
    false
  ),
  'private.enforce_notebook_source_limit() is not SECURITY DEFINER'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(p.proconfig, '{}'))
     from pg_proc p where p.oid = pg_temp.proc_oid('private', 'enforce_notebook_source_limit')),
    false
  ),
  'private.enforce_notebook_source_limit() sets search_path to an exact empty string'
);
select ok(
  not coalesce(
    has_function_privilege('authenticated', pg_temp.proc_oid('private', 'enforce_notebook_source_limit'), 'EXECUTE'),
    false
  ),
  'authenticated cannot execute private.enforce_notebook_source_limit()'
);

select ok(
  pg_temp.proc_oid('private', 'enforce_notebook_chunk_limit') is not null,
  'private.enforce_notebook_chunk_limit() exists'
);
select ok(
  coalesce(
    (select not p.prosecdef from pg_proc p where p.oid = pg_temp.proc_oid('private', 'enforce_notebook_chunk_limit')),
    false
  ),
  'private.enforce_notebook_chunk_limit() is not SECURITY DEFINER'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(p.proconfig, '{}'))
     from pg_proc p where p.oid = pg_temp.proc_oid('private', 'enforce_notebook_chunk_limit')),
    false
  ),
  'private.enforce_notebook_chunk_limit() sets search_path to an exact empty string'
);
select ok(
  not coalesce(
    has_function_privilege('authenticated', pg_temp.proc_oid('private', 'enforce_notebook_chunk_limit'), 'EXECUTE'),
    false
  ),
  'authenticated cannot execute private.enforce_notebook_chunk_limit()'
);

-- ---------------------------------------------------------------------------
-- 4) Triggers: exact timing/level and (for the chunk trigger) the
-- transition-table reference
-- ---------------------------------------------------------------------------

select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'status'
    where n.nspname = 'public' and c.relname = 'sources'
      and t.tgfoid = pg_temp.proc_oid('private', 'touch_source_status')
      and not t.tgisinternal
      and (t.tgtype & 2) = 2   -- BEFORE
      and (t.tgtype & 16) = 16 -- UPDATE
      and (t.tgtype & 1) = 1   -- ROW
      and a.attnum = any(t.tgattr)
  ),
  'sources has a BEFORE UPDATE OF status FOR EACH ROW trigger calling private.touch_source_status()'
);

select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources'
      and t.tgfoid = pg_temp.proc_oid('private', 'enforce_notebook_source_limit')
      and not t.tgisinternal
      and (t.tgtype & 2) = 2 -- BEFORE
      and (t.tgtype & 4) = 4 -- INSERT
      and (t.tgtype & 1) = 1 -- ROW
  ),
  'sources has a BEFORE INSERT FOR EACH ROW trigger calling private.enforce_notebook_source_limit()'
);

select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'chunks'
      and t.tgfoid = pg_temp.proc_oid('private', 'enforce_notebook_chunk_limit')
      and not t.tgisinternal
      and (t.tgtype & 2) = 0 -- AFTER (BEFORE bit unset)
      and (t.tgtype & 4) = 4 -- INSERT
      and (t.tgtype & 1) = 0 -- STATEMENT (ROW bit unset)
      and t.tgnewtable = 'inserted'
  ),
  'chunks has an AFTER INSERT FOR EACH STATEMENT trigger (REFERENCING NEW TABLE AS inserted) calling private.enforce_notebook_chunk_limit()'
);

-- ---------------------------------------------------------------------------
-- 5) Behavioural fixtures: a real owner, a real notebook, real sources
-- ---------------------------------------------------------------------------

create table pg_temp.ingestion_fixture (
  owner_id uuid not null default gen_random_uuid(),
  notebook_id uuid not null default gen_random_uuid(),
  source_a_id uuid,
  source_b_id uuid,
  source_c_id uuid,
  before_ts text,
  after_ts text,
  before_title_ts text,
  after_title_ts text
);
insert into pg_temp.ingestion_fixture default values;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select owner_id, owner_id::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from pg_temp.ingestion_fixture;

select pg_temp.act_lives(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_id from pg_temp.ingestion_fixture), 'ingestion fixture notebook'
  ),
  'fixture: the owner creates a real notebook'
);

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'source A') returning id $f$,
    (select notebook_id from pg_temp.ingestion_fixture)
  ),
  'fixture: the owner creates source A'
);
update pg_temp.ingestion_fixture
  set source_a_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

-- ---------------------------------------------------------------------------
-- 6) status_changed_at behaviour
-- ---------------------------------------------------------------------------

update pg_temp.ingestion_fixture
  set before_ts = pg_temp.act_scalar(
    owner_id,
    format('select status_changed_at::text from public.sources where id = %L', source_a_id)
  );

select pg_temp.act_lives(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set status = %L where id = %L',
    'processing', (select source_a_id from pg_temp.ingestion_fixture)
  ),
  'the owner updates source A''s status to processing'
);

update pg_temp.ingestion_fixture
  set after_ts = pg_temp.act_scalar(
    owner_id,
    format('select status_changed_at::text from public.sources where id = %L', source_a_id)
  );

-- Compared via a dynamically-executed cast (safe_ok) rather than a bare
-- `select ok(...)`: pre-migration, before_ts/after_ts hold act_scalar's own
-- 'ERROR:42703' string (status_changed_at does not exist yet), and casting
-- that to timestamptz at CREATE- or plan-time would abort the whole
-- transaction instead of reporting one clean FAIL.
select pg_temp.safe_ok(
  format(
    $sql$ select (%L::timestamptz) > (%L::timestamptz) $sql$,
    (select after_ts from pg_temp.ingestion_fixture),
    (select before_ts from pg_temp.ingestion_fixture)
  ),
  'status_changed_at advances after a status update (allowing for clock resolution)'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set status_changed_at = now() where id = %L',
    (select source_a_id from pg_temp.ingestion_fixture)
  ),
  '42501',
  'a direct update of status_changed_at by the owner is denied with 42501 (no update grant on this column)'
);

update pg_temp.ingestion_fixture
  set before_title_ts = pg_temp.act_scalar(
    owner_id,
    format('select status_changed_at::text from public.sources where id = %L', source_a_id)
  );

select pg_temp.act_lives(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set title = %L where id = %L',
    'retitled by the touch test', (select source_a_id from pg_temp.ingestion_fixture)
  ),
  'the owner updates source A''s title only'
);

update pg_temp.ingestion_fixture
  set after_title_ts = pg_temp.act_scalar(
    owner_id,
    format('select status_changed_at::text from public.sources where id = %L', source_a_id)
  );

-- Equality alone would pass vacuously pre-migration (both sides hold the
-- same 'ERROR:42703' string), so this also requires neither side to be an
-- error marker.
select pg_temp.safe_ok(
  format(
    $sql$ select %L not like 'ERROR:%%' and %L not like 'ERROR:%%' and (%L::text) = (%L::text) $sql$,
    (select before_title_ts from pg_temp.ingestion_fixture),
    (select after_title_ts from pg_temp.ingestion_fixture),
    (select before_title_ts from pg_temp.ingestion_fixture),
    (select after_title_ts from pg_temp.ingestion_fixture)
  ),
  'a title-only update leaves status_changed_at unchanged'
);

-- ---------------------------------------------------------------------------
-- 7) error_category check constraints
-- ---------------------------------------------------------------------------

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'source B') returning id $f$,
    (select notebook_id from pg_temp.ingestion_fixture)
  ),
  'fixture: the owner creates source B (for the bad-category check)'
);
update pg_temp.ingestion_fixture
  set source_b_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.act_lives(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set status = %L where id = %L',
    'failed', (select source_b_id from pg_temp.ingestion_fixture)
  ),
  'the owner moves source B to failed'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set error_category = %L where id = %L',
    'Bad-Cat', (select source_b_id from pg_temp.ingestion_fixture)
  ),
  '23514',
  'an error_category that does not match ^[a-z_]{1,40}$ is rejected with 23514'
);

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'source C') returning id $f$,
    (select notebook_id from pg_temp.ingestion_fixture)
  ),
  'fixture: the owner creates source C (for the only-while-failed check)'
);
update pg_temp.ingestion_fixture
  set source_c_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.act_lives(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set status = %L where id = %L',
    'ready', (select source_c_id from pg_temp.ingestion_fixture)
  ),
  'the owner moves source C to ready'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.ingestion_fixture),
  format(
    'update public.sources set error_category = %L where id = %L',
    'no_text', (select source_c_id from pg_temp.ingestion_fixture)
  ),
  '23514',
  'setting error_category while status is ready is rejected with 23514'
);

-- ---------------------------------------------------------------------------
-- 8) Per-notebook source cap (50)
-- ---------------------------------------------------------------------------

create table pg_temp.cap_fixture (
  owner_id uuid,
  notebook_id uuid not null default gen_random_uuid(),
  other_notebook_id uuid not null default gen_random_uuid()
);
insert into pg_temp.cap_fixture (owner_id)
select owner_id from pg_temp.ingestion_fixture;

select pg_temp.act_lives(
  (select owner_id from pg_temp.cap_fixture),
  format(
    'insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_id from pg_temp.cap_fixture), 'ingestion cap notebook'
  ),
  'fixture: the owner creates the source-cap notebook'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.cap_fixture),
  format(
    $sql$ insert into public.sources (notebook_id, kind, title)
          select %L, 'text', 'cap-source-' || gs
          from generate_series(1, 50) as gs $sql$,
    (select notebook_id from pg_temp.cap_fixture)
  ),
  'the owner inserts exactly 50 sources into the cap notebook in one statement'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.cap_fixture),
  format(
    $sql$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'cap-source-51') $sql$,
    (select notebook_id from pg_temp.cap_fixture)
  ),
  '54000',
  'the 51st source insert is rejected with 54000'
);

select ok(
  pg_temp.act_error_message(
    (select owner_id from pg_temp.cap_fixture),
    format(
      $sql$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'cap-source-51-again') $sql$,
      (select notebook_id from pg_temp.cap_fixture)
    )
  ) ilike '%notebook_source_limit%',
  'the 51st source insert''s error message mentions notebook_source_limit'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.cap_fixture),
  format(
    'insert into public.notebooks (id, title) values (%L, %L)',
    (select other_notebook_id from pg_temp.cap_fixture), 'ingestion cap sibling notebook'
  ),
  'fixture: the owner creates a second, sibling notebook'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.cap_fixture),
  format(
    $sql$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'unaffected sibling source') $sql$,
    (select other_notebook_id from pg_temp.cap_fixture)
  ),
  'the sibling notebook is unaffected: a source insert into it still succeeds'
);

-- ---------------------------------------------------------------------------
-- 9) Per-notebook chunk cap (20,000), driven directly as postgres (see file
-- header for why)
-- ---------------------------------------------------------------------------

create table pg_temp.chunk_cap_fixture (
  owner_id uuid,
  notebook_id uuid not null default gen_random_uuid(),
  source_x_id uuid,
  source_y_id uuid,
  other_notebook_id uuid not null default gen_random_uuid(),
  source_z_id uuid
);
insert into pg_temp.chunk_cap_fixture (owner_id)
select owner_id from pg_temp.ingestion_fixture;

select pg_temp.act_lives(
  (select owner_id from pg_temp.chunk_cap_fixture),
  format(
    'insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_id from pg_temp.chunk_cap_fixture), 'ingestion chunk-cap notebook'
  ),
  'fixture: the owner creates the chunk-cap notebook'
);

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.chunk_cap_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'chunk-cap source X') returning id $f$,
    (select notebook_id from pg_temp.chunk_cap_fixture)
  ),
  'fixture: the owner creates source X in the chunk-cap notebook'
);
update pg_temp.chunk_cap_fixture
  set source_x_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.chunk_cap_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'chunk-cap source Y') returning id $f$,
    (select notebook_id from pg_temp.chunk_cap_fixture)
  ),
  'fixture: the owner creates source Y in the chunk-cap notebook'
);
update pg_temp.chunk_cap_fixture
  set source_y_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.sql_lives(
  format(
    $sql$ insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
          select %L, case when gs %% 2 = 0 then %L::uuid else %L::uuid end, gs, 'chunk ' || gs, null,
                 array_fill(0.01::real, array[1024])::extensions.vector
          from generate_series(1, 20000) as gs $sql$,
    (select notebook_id from pg_temp.chunk_cap_fixture),
    (select source_x_id from pg_temp.chunk_cap_fixture),
    (select source_y_id from pg_temp.chunk_cap_fixture)
  ),
  'postgres inserts exactly 20,000 chunks into the chunk-cap notebook, split across 2 sources, in one statement'
);

select pg_temp.sql_throws(
  format(
    $sql$ insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
          values (%L, %L, 20001, 'one too many', null, array_fill(0.01::real, array[1024])::extensions.vector) $sql$,
    (select notebook_id from pg_temp.chunk_cap_fixture),
    (select source_x_id from pg_temp.chunk_cap_fixture)
  ),
  '54000',
  'the 20,001st chunk insert is rejected with 54000'
);

select ok(
  pg_temp.sql_error_message(
    format(
      $sql$ insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
            values (%L, %L, 20002, 'still one too many', null, array_fill(0.01::real, array[1024])::extensions.vector) $sql$,
      (select notebook_id from pg_temp.chunk_cap_fixture),
      (select source_x_id from pg_temp.chunk_cap_fixture)
    )
  ) ilike '%notebook_chunk_limit%',
  'the 20,001st chunk insert''s error message mentions notebook_chunk_limit'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.chunk_cap_fixture),
  format(
    'insert into public.notebooks (id, title) values (%L, %L)',
    (select other_notebook_id from pg_temp.chunk_cap_fixture), 'ingestion chunk-cap sibling notebook'
  ),
  'fixture: the owner creates a second, sibling notebook for the chunk cap'
);

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.chunk_cap_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'sibling chunk-cap source') returning id $f$,
    (select other_notebook_id from pg_temp.chunk_cap_fixture)
  ),
  'fixture: the owner creates a source in the sibling notebook'
);
update pg_temp.chunk_cap_fixture
  set source_z_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.sql_lives(
  format(
    $sql$ insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
          values (%L, %L, 0, 'sibling notebook chunk', null, array_fill(0.01::real, array[1024])::extensions.vector) $sql$,
    (select other_notebook_id from pg_temp.chunk_cap_fixture),
    (select source_z_id from pg_temp.chunk_cap_fixture)
  ),
  'the sibling notebook is unaffected: a chunk insert into it still succeeds'
);

select * from finish();

rollback;
