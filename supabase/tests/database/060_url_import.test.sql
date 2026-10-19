-- Catalog and behavioural tests for PR C2 (URL import): the new column
-- public.sources.source_url and its three named check constraints
-- (sources_source_url_format, sources_source_url_only_url and the NOT VALID
-- sources_url_has_source_url), the column grants (INSERT for authenticated, no
-- UPDATE: the URL is immutable; nothing for anon), the behaviour of the checks
-- for real inserts and updates, and the legacy case: a kind 'url' row written
-- before the migration (the kind grant existed since A1) has no URL, so the NOT
-- VALID constraint lets it be deleted but not updated.
-- 000_catalog.test.sql already proves the general invariants (RLS on, no FOR ALL
-- policy, no SECURITY DEFINER outside the allowlist, ...). C2 adds no policy,
-- function or trigger, so this file only adds what is specific to the column.
--
-- Setup follows 050_ingestion.test.sql: the pg_temp helpers are redefined here
-- verbatim in shape (pg_temp does not persist across the psql connections
-- pg_prove opens per file). Everything that touches the new column before the
-- migration exists goes through a helper (dynamic SQL), so a missing column or
-- constraint is reported as a clean pgTAP FAIL and never aborts the transaction.
--
-- The legacy row cannot be inserted through the live constraint, so the test
-- drops sources_url_has_source_url as postgres, inserts the legacy row and adds
-- the constraint back as NOT VALID, exactly the state the migration leaves a
-- database in. All of it is rolled back at the end.

begin;

select plan(40);

-- ---------------------------------------------------------------------------
-- Helpers
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

-- Runs `probe` as `actor_id` under role authenticated, expected to return one
-- text-castable scalar; on error returns 'ERROR:<sqlstate>'.
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

-- Runs `probe` (one boolean-castable scalar), defaulting to false on any error.
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
-- 1) Column shape and named constraints (catalog introspection)
-- ---------------------------------------------------------------------------

select ok(
  coalesce(
    (select t.typname = 'text' and not a.attnotnull
     from pg_attribute a
     join pg_type t on t.oid = a.atttypid
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and a.attname = 'source_url'
       and not a.attisdropped),
    false
  ),
  'sources.source_url is a nullable text column'
);

select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources' and con.contype = 'c'
      and con.conname = 'sources_source_url_format'
  ),
  'sources has a check constraint named sources_source_url_format'
);

select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources' and con.contype = 'c'
      and con.conname = 'sources_source_url_only_url'
  ),
  'sources has a check constraint named sources_source_url_only_url'
);

select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources' and con.contype = 'c'
      and con.conname = 'sources_url_has_source_url'
  ),
  'sources has a check constraint named sources_url_has_source_url'
);

select ok(
  coalesce(
    (select not con.convalidated
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and con.conname = 'sources_url_has_source_url'),
    false
  ),
  'sources_url_has_source_url is NOT VALID (legacy url rows without a URL must not fail the migration)'
);

select ok(
  coalesce(
    (select bool_and(con.convalidated)
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources'
       and con.conname in ('sources_source_url_format', 'sources_source_url_only_url')
     having count(*) = 2),
    false
  ),
  'sources_source_url_format and sources_source_url_only_url are validated'
);

select ok(
  coalesce(
    (select pg_get_constraintdef(con.oid) like '%2048%' and pg_get_constraintdef(con.oid) like '%https?://%'
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and con.conname = 'sources_source_url_format'),
    false
  ),
  'sources_source_url_format limits the length to 2048 and requires an http(s) scheme'
);

-- ---------------------------------------------------------------------------
-- 2) Column-level grants
-- ---------------------------------------------------------------------------

select pg_temp.safe_ok(
  $$ select has_column_privilege('authenticated', 'public.sources'::regclass, 'source_url', 'INSERT') $$,
  'authenticated has INSERT on sources.source_url'
);
select pg_temp.safe_ok(
  $$ select not has_column_privilege('authenticated', 'public.sources'::regclass, 'source_url', 'UPDATE') $$,
  'authenticated has no UPDATE on sources.source_url (the URL is immutable)'
);
select pg_temp.safe_ok(
  $$ select has_column_privilege('authenticated', 'public.sources'::regclass, 'source_url', 'SELECT') $$,
  'authenticated has SELECT on sources.source_url'
);
select pg_temp.safe_ok(
  $$ select not has_column_privilege('anon', 'public.sources'::regclass, 'source_url', 'INSERT') $$,
  'anon has no INSERT on sources.source_url'
);
select pg_temp.safe_ok(
  $$ select not has_column_privilege('anon', 'public.sources'::regclass, 'source_url', 'UPDATE') $$,
  'anon has no UPDATE on sources.source_url'
);
select pg_temp.safe_ok(
  $$ select not has_column_privilege('anon', 'public.sources'::regclass, 'source_url', 'SELECT') $$,
  'anon has no SELECT on sources.source_url'
);

-- ---------------------------------------------------------------------------
-- 3) Behaviour: fixtures (a real owner, a viewer, a stranger, a notebook)
-- ---------------------------------------------------------------------------

create table pg_temp.url_fixture (
  owner_id uuid not null default gen_random_uuid(),
  viewer_id uuid not null default gen_random_uuid(),
  stranger_id uuid not null default gen_random_uuid(),
  notebook_id uuid not null default gen_random_uuid(),
  source_id uuid,
  legacy_id uuid not null default gen_random_uuid()
);
insert into pg_temp.url_fixture default values;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u.id, u.id::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (
  select owner_id as id from pg_temp.url_fixture
  union all select viewer_id from pg_temp.url_fixture
  union all select stranger_id from pg_temp.url_fixture
) u;

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format(
    'insert into public.notebooks (id, title) values (%L, %L)',
    (select notebook_id from pg_temp.url_fixture), 'url import fixture notebook'
  ),
  'fixture: the owner creates a real notebook'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format(
    'insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_id from pg_temp.url_fixture), (select viewer_id from pg_temp.url_fixture), 'viewer'
  ),
  'fixture: the owner adds the viewer'
);

-- ---------------------------------------------------------------------------
-- 4) Behaviour: inserts, constraint violations, immutability, visibility
-- ---------------------------------------------------------------------------

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'url source', 'https://example.com/artikel') returning id $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  'the owner inserts a url source with an https URL'
);
update pg_temp.url_fixture
  set source_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'http source', 'http://example.com/seite') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  'the owner inserts a url source with an http URL'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'url', 'url without a URL') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '23514',
  'kind url without source_url is rejected with 23514 (sources_url_has_source_url applies to new rows)'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'text', 'text with url', 'https://example.com/') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '23514',
  'kind text with a source_url is rejected with 23514'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'pdf', 'pdf with url', 'https://example.com/') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '23514',
  'kind pdf with a source_url is rejected with 23514'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'js url', 'javascript:x') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '23514',
  'a javascript: source_url is rejected with 23514'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'ftp url', 'ftp://example.com/') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '23514',
  'an ftp: source_url is rejected with 23514'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'long url', 'https://example.com/' || repeat('a', 2029)) $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '23514',
  'a 2049-character source_url is rejected with 23514'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'max url', 'https://example.com/' || repeat('a', 2028)) $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  'a 2048-character source_url is accepted'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ update public.sources set source_url = 'https://example.org/other' where id = %L $f$,
    (select source_id from pg_temp.url_fixture)
  ),
  '42501',
  'the owner cannot update source_url (no update grant: the URL is immutable)'
);

select is(
  pg_temp.act_scalar(
    (select owner_id from pg_temp.url_fixture),
    format('select source_url from public.sources where id = %L', (select source_id from pg_temp.url_fixture))
  ),
  'https://example.com/artikel',
  'the owner reads the stored URL back, unchanged'
);

select pg_temp.act_throws(
  (select viewer_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'viewer url', 'https://example.com/') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '42501',
  'a viewer cannot insert a url source (42501)'
);

select pg_temp.act_throws(
  (select stranger_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title, source_url)
        values (%L, 'url', 'stranger url', 'https://example.com/') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  '42501',
  'a stranger cannot insert a url source (42501)'
);

select is(
  pg_temp.act_scalar(
    (select viewer_id from pg_temp.url_fixture),
    format('select source_url from public.sources where id = %L', (select source_id from pg_temp.url_fixture))
  ),
  'https://example.com/artikel',
  'a viewer sees the stored URL'
);

select is(
  pg_temp.act_scalar(
    (select stranger_id from pg_temp.url_fixture),
    format('select count(*)::text from public.sources where id = %L', (select source_id from pg_temp.url_fixture))
  ),
  '0',
  'a stranger sees no row, so no URL'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'text without url') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  'a text source without source_url is still accepted (the previous app version keeps working)'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'pdf', 'pdf without url') $f$,
    (select notebook_id from pg_temp.url_fixture)
  ),
  'a pdf source without source_url is still accepted (the previous app version keeps working)'
);

-- ---------------------------------------------------------------------------
-- 5) Legacy url row without a URL: deletable, not updatable
-- ---------------------------------------------------------------------------

-- Three separate statements on purpose: an ALTER TABLE in the same statement as the
-- insert would fail on the insert's pending foreign key trigger events.
select pg_temp.sql_lives(
  'alter table public.sources drop constraint if exists sources_url_has_source_url',
  'fixture: sources_url_has_source_url is dropped for a moment (as postgres, rolled back at the end)'
);

select pg_temp.sql_lives(
  format(
    $sql$ insert into public.sources (id, notebook_id, kind, title)
          values (%L, %L, 'url', 'legacy url row without a URL') $sql$,
    (select legacy_id from pg_temp.url_fixture),
    (select notebook_id from pg_temp.url_fixture)
  ),
  'fixture: a legacy url row without a URL is inserted'
);

select pg_temp.sql_lives(
  $sql$ alter table public.sources
        add constraint sources_url_has_source_url
        check (kind <> 'url' or source_url is not null) not valid $sql$,
  'fixture: sources_url_has_source_url is back as NOT VALID, the state the migration leaves behind'
);

select is(
  pg_temp.act_scalar(
    (select owner_id from pg_temp.url_fixture),
    format('select count(*)::text from public.sources where id = %L', (select legacy_id from pg_temp.url_fixture))
  ),
  '1',
  'the owner can still read the legacy row'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    'update public.sources set title = %L where id = %L',
    'retitled legacy', (select legacy_id from pg_temp.url_fixture)
  ),
  '23514',
  'updating a legacy url row without a URL is rejected with 23514'
);

select pg_temp.act_throws(
  (select owner_id from pg_temp.url_fixture),
  format(
    'update public.sources set status = %L where id = %L',
    'processing', (select legacy_id from pg_temp.url_fixture)
  ),
  '23514',
  'claiming (status update) a legacy url row without a URL is rejected with 23514'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.url_fixture),
  format('delete from public.sources where id = %L', (select legacy_id from pg_temp.url_fixture)),
  'the owner can delete the legacy url row'
);

select is(
  pg_temp.act_scalar(
    (select owner_id from pg_temp.url_fixture),
    format('select count(*)::text from public.sources where id = %L', (select legacy_id from pg_temp.url_fixture))
  ),
  '0',
  'the legacy url row is gone after the delete'
);

select * from finish();

rollback;
