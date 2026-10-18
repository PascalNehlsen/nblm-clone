-- Catalog and behavioural tests for PR A2 (the `sources` Storage bucket and
-- its storage.objects policies). 000_catalog.test.sql proves the general
-- invariants (RLS on, no FOR ALL policy, no stray SECURITY DEFINER, anon has
-- nothing, etc) that apply to tables in `public`/`private`; storage.objects is
-- a schema Supabase itself owns, so none of those checks look at it, and this
-- file is the only place that pins its shape down. 020_sources_chunks_messages
-- .test.sql already proves public.sources' own contract (generated
-- storage_path, server-only id); this file proves A2's contract on top of
-- that: the bucket's configuration, the per-command policy shape on
-- storage.objects, and that an object name that matches no real source can
-- never make a policy raise instead of simply denying.
--
-- Human requirement update (after the first draft of this PR): a leftover
-- object must stop being reachable the moment its *sources row* is deleted,
-- not only once the whole notebook is gone -- deleting a notebook cascades
-- away its sources rows (see 020's notebook/source cascade fixtures), so that
-- case was already covered by the same mechanism, but a source can also be
-- deleted on its own while the object stays in Storage (expand-contract style
-- cleanup, PR C). So select, insert AND delete all look the object's `name`
-- up as a `public.sources.storage_path` and read membership off *that row's*
-- `notebook_id` -- not just insert, and not by parsing or casting any part of
-- the object name itself. There is still no update policy at all (no
-- overwrite/upsert, and no move/rename -- a move is implemented as an update
-- of `name`), and restrictive is_anonymous-blocking policies on insert and
-- delete (select has no such restriction: an anonymous-signin member may
-- still read/download, same as sources/chunks select).
--
-- This file only proves the catalog shape and the one cross-cutting safety
-- property that an object name with no matching `public.sources.storage_path`
-- row -- whatever text it contains -- is simply treated as "no such row"
-- (denied) and never raises out of a policy expression: the lookup is a plain
-- equality join on text, so there is no uuid (or other) cast of attacker-
-- controlled input anywhere in it to raise 22P02 in the first place. This file
-- never signs in two different real users and watches one deny the other that
-- way; that full owner/editor/viewer/stranger/anon/anonymous-member matrix,
-- through the real Storage API, lives in tests/rls/storage.test.ts, which is
-- the only place that can exercise upload/download/remove/move/copy the way
-- the app actually will.
--
-- Policies are identified structurally, not by name: `polcmd` for the
-- command, `polpermissive` for permissive vs restrictive, `'authenticated'::
-- regrole = any(polroles)` for "scoped to the authenticated role" (an empty/
-- public policy has polroles = '{0}', which never matches a real role's
-- regrole value), and a literal substring match against the deparsed
-- qual/with_check text for "scoped to bucket sources" (`'sources'` as a
-- quoted literal), "requires an existing sources row" (`storage_path`) and
-- "goes through the one allowed membership helper" (`notebook_role`). A
-- substring match is deliberately loose about exact SQL shape -- the point is
-- that the migration's author cannot satisfy these checks by writing a
-- membership check some other way (inline joins against notebook_members,
-- for instance), which AGENTS.md's single-helper rule forbids.
--
-- Fixture rows for the malformed-path safety check are inserted directly into
-- storage.objects, as `postgres` (a local superuser, so RLS does not apply to
-- the insert itself -- same assumption 010/020 already make for auth.users).
-- Before this PR's migration creates the `sources` bucket, that insert itself
-- fails (storage.objects.bucket_id is a foreign key into storage.buckets),
-- which is exactly the right failure for a file testing a migration that has
-- not landed yet: pg_temp.sql_lives below turns that into a plain, readable
-- pgTAP FAIL instead of aborting the whole script (same pattern as 010/020;
-- see those files' headers for why a bare top-level statement cannot be used
-- here).

begin;

select plan(45);

-- ---------------------------------------------------------------------------
-- Helpers (verbatim shape from 010/020_*.test.sql; redefined here because
-- pg_temp does not persist across the separate psql connections pg_prove
-- opens per file)
-- ---------------------------------------------------------------------------

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

-- Runs `probe` (expected to return one text-castable scalar) as `actor_id`
-- under role authenticated, with a real-looking (non-anonymous) JWT. Returns
-- the scalar on success, or 'ERROR:<sqlstate>' on failure -- never raises --
-- so the caller can assert on the value either way, exactly like
-- 020_sources_chunks_messages.test.sql's act_scalar.
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

-- Runs `probe` as `actor_id` under role authenticated; reports a thrown error
-- as a pgTAP FAIL with the real message, same shape as 010/020's act_lives.
-- Used below for real membership fixtures (creating a notebook, a source),
-- not for the policy-safety probes above.
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

-- Same shape as 020's act_insert_id: runs an "INSERT ... RETURNING id" probe
-- as `actor_id`, stashing the id in a session GUC (PERFORM discards a query
-- result outright, so it cannot be returned directly alongside the pgTAP
-- line this function also has to print -- see 020's header for the full
-- explanation) for a plain follow-up statement to read back.
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

-- Structural helpers over pg_policy, scoped to storage.objects.
create function pg_temp.objects_policy_exists(cmd text, permissive boolean) returns boolean as $$
  select exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and p.polcmd = cmd
      and p.polpermissive = permissive
      and 'authenticated'::regrole = any(p.polroles)
      and (
        coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%''sources''%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%''sources''%'
      )
  );
$$ language sql;

create function pg_temp.objects_policy_text(cmd text, permissive boolean) returns text as $$
  select coalesce(string_agg(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), ' ')
      || ' ' || string_agg(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), ' '), '')
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects'
    and p.polcmd = cmd
    and p.polpermissive = permissive
    and 'authenticated'::regrole = any(p.polroles)
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%''sources''%'
      or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%''sources''%'
    );
$$ language sql;

create function pg_temp.objects_any_policy_scoped_to_sources(cmd text) returns boolean as $$
  select exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and p.polcmd = cmd
      and (
        coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%''sources''%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%''sources''%'
      )
  );
$$ language sql;

create function pg_temp.objects_restrictive_anon_block(cmd text) returns boolean as $$
  select exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and p.polcmd = cmd
      and not p.polpermissive
      and (
        coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%is_anonymous%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%is_anonymous%'
      )
      and (
        coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%''sources''%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%''sources''%'
      )
  );
$$ language sql;

-- ---------------------------------------------------------------------------
-- 1) storage.buckets: the `sources` bucket
-- ---------------------------------------------------------------------------

select ok(
  exists (select 1 from storage.buckets where id = 'sources'),
  'storage.buckets has a row for bucket "sources"'
);
select ok(
  coalesce((select public = false from storage.buckets where id = 'sources'), false),
  'bucket "sources" is private (public = false)'
);
select ok(
  coalesce((select file_size_limit = 20971520 from storage.buckets where id = 'sources'), false),
  'bucket "sources" file_size_limit is exactly 20 MiB (20971520 bytes)'
);
select ok(
  coalesce(
    (select array(select unnest(allowed_mime_types) order by 1) from storage.buckets where id = 'sources')
      = array['application/pdf', 'text/plain'],
    false
  ),
  'bucket "sources" allowed_mime_types is exactly {application/pdf, text/plain}'
);

-- ---------------------------------------------------------------------------
-- 2) storage.objects policies: select, insert, delete all require BOTH
-- membership (via private.notebook_role, the one allowed helper) AND an
-- existing public.sources row for the path (via storage_path)
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.objects_policy_exists('r', true),
  'storage.objects has a permissive select policy for authenticated, scoped to bucket sources'
);
select ok(
  pg_temp.objects_policy_text('r', true) ilike '%notebook_role%',
  'the select policy checks membership through private.notebook_role(...)'
);
select ok(
  pg_temp.objects_policy_text('r', true) ilike '%storage_path%',
  'the select policy also requires an existing public.sources row (storage_path = name)'
);

select ok(
  pg_temp.objects_policy_exists('a', true),
  'storage.objects has a permissive insert policy for authenticated, scoped to bucket sources'
);
select ok(
  pg_temp.objects_policy_text('a', true) ilike '%notebook_role%',
  'the insert policy checks membership through private.notebook_role(...)'
);
select ok(
  pg_temp.objects_policy_text('a', true) ilike '%storage_path%',
  'the insert policy requires an existing public.sources row (storage_path = name), no orphan uploads'
);
select ok(
  pg_temp.objects_policy_text('a', true) ilike '%owner%' and pg_temp.objects_policy_text('a', true) ilike '%editor%',
  'the insert policy allows both owner and editor'
);
select ok(
  pg_temp.objects_policy_text('a', true) not ilike '%viewer%',
  'the insert policy does not mention viewer (a viewer cannot add sources)'
);

select ok(
  pg_temp.objects_policy_exists('d', true),
  'storage.objects has a permissive delete policy for authenticated, scoped to bucket sources'
);
select ok(
  pg_temp.objects_policy_text('d', true) ilike '%notebook_role%',
  'the delete policy checks membership through private.notebook_role(...)'
);
select ok(
  pg_temp.objects_policy_text('d', true) ilike '%storage_path%',
  'the delete policy also requires an existing public.sources row (storage_path = name)'
);
select ok(
  pg_temp.objects_policy_text('d', true) ilike '%owner%' and pg_temp.objects_policy_text('d', true) ilike '%editor%',
  'the delete policy allows both owner and editor'
);
select ok(
  pg_temp.objects_policy_text('d', true) not ilike '%viewer%',
  'the delete policy does not mention viewer'
);

-- ---------------------------------------------------------------------------
-- 3) No update policy at all, and no FOR ALL policy, scoped to bucket sources
-- ---------------------------------------------------------------------------

select ok(
  not pg_temp.objects_any_policy_scoped_to_sources('w'),
  'no update policy (permissive or restrictive) on storage.objects is scoped to bucket sources -- no overwrite/upsert'
);
select ok(
  not pg_temp.objects_any_policy_scoped_to_sources('*'),
  'no FOR ALL policy on storage.objects is scoped to bucket sources'
);

-- ---------------------------------------------------------------------------
-- 4) Restrictive anonymous-blocking policies: insert and delete only (select
-- has none -- an anonymous-signin member may still read, same as sources
-- itself)
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.objects_restrictive_anon_block('a'),
  'storage.objects has a restrictive is_anonymous-blocking policy for insert, scoped to bucket sources'
);
select ok(
  pg_temp.objects_restrictive_anon_block('d'),
  'storage.objects has a restrictive is_anonymous-blocking policy for delete, scoped to bucket sources'
);

-- ---------------------------------------------------------------------------
-- 5) Behavioural fixtures: a real member, a real source with a real object,
-- and a sibling "orphan" object in the *same* real notebook (a well-formed
-- uuid pair, but no matching sources row) -- so the member-side check below
-- is not vacuous: it has to actually distinguish the two, not just see "some
-- number of rows" or "zero rows because nothing exists yet".
-- ---------------------------------------------------------------------------

create table pg_temp.fixture (
  owner_id uuid not null,
  viewer_id uuid not null,
  notebook_id uuid not null,
  source_id uuid,
  real_path text,
  orphan_path text,
  owner_delete_source_id uuid,
  owner_delete_path text,
  viewer_target_source_id uuid,
  viewer_target_path text,
  leftover_source_id uuid,
  leftover_path text
);
insert into pg_temp.fixture (owner_id, viewer_id, notebook_id, orphan_path)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), null);
update pg_temp.fixture set orphan_path = (select notebook_id from pg_temp.fixture)::text || '/' || gen_random_uuid()::text;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (select unnest(array[owner_id, viewer_id]) as u from pg_temp.fixture) as users;

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_id from pg_temp.fixture), 'storage fixture notebook'),
  'fixture: the owner creates a real notebook'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'storage fixture source') returning id $f$,
    (select notebook_id from pg_temp.fixture)
  ),
  'fixture: the owner creates a real source in that notebook'
);
update pg_temp.fixture set source_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
update pg_temp.fixture
  set real_path = notebook_id::text || '/' || source_id::text
  where source_id is not null;

-- Before the migration lands, bucket "sources" does not exist yet, so every
-- insert into storage.objects below fails with 23503 (foreign key violation)
-- -- a correct, readable red for a migration that has not landed, not a
-- crash: pg_temp.sql_lives turns it into a plain pgTAP FAIL (same pattern as
-- 010/020; see those files' headers for why a bare top-level statement
-- cannot be used here).
select pg_temp.sql_lives(
  format($sql$ insert into storage.objects (bucket_id, name) values ('sources', %L) $sql$, (select real_path from pg_temp.fixture)),
  'fixture: insert the real storage.objects row for the fixture source'
);
select pg_temp.sql_lives(
  format($sql$ insert into storage.objects (bucket_id, name) values ('sources', %L) $sql$, (select orphan_path from pg_temp.fixture)),
  'fixture: insert a sibling storage.objects row in the same real notebook, with no matching sources row'
);
select pg_temp.sql_lives(
  $sql$ insert into storage.objects (bucket_id, name) values ('sources', 'not-a-uuid/x') $sql$,
  'fixture: insert a storage.objects row whose name does not look like any storage_path at all'
);
select pg_temp.sql_lives(
  $sql$ insert into storage.objects (bucket_id, name) values ('sources', '') $sql$,
  'fixture: insert a storage.objects row with an empty name'
);
select pg_temp.sql_lives(
  $sql$ insert into storage.objects (bucket_id, name) values ('sources', 'a/b/c') $sql$,
  'fixture: insert a storage.objects row with more than two path segments'
);
select pg_temp.sql_lives(
  format(
    $sql$ insert into storage.objects (bucket_id, name) values ('sources', %L) $sql$,
    gen_random_uuid()::text || '/' || gen_random_uuid()::text
  ),
  'fixture: insert a storage.objects row with a syntactically valid uuid pair, in a notebook that does not exist'
);

-- Non-vacuous member-side check: the real owner, a genuine member of the
-- fixture notebook, must see *exactly* the one object that has a matching
-- sources row -- not the sibling orphan sitting right next to it in the same
-- notebook, not 0 (there really is one visible row), not 2, and no error.
select is(
  pg_temp.act_scalar(
    (select owner_id from pg_temp.fixture),
    format(
      $sql$ select count(*)::text from storage.objects where bucket_id = 'sources' and name like %L $sql$,
      (select notebook_id from pg_temp.fixture) || '/%'
    )
  ),
  '1',
  'the real owner sees exactly the one object with a matching sources row in their own notebook, not its row-less sibling'
);

-- An unrelated authenticated user, a member of nothing: every row inserted
-- above (the real one, its orphan sibling, and the three malformed names)
-- must come back as plain count 0, never 'ERROR:...'. A 22P02 (invalid input
-- syntax for type uuid) from an unguarded cast anywhere in the policy would
-- show up here as 'ERROR:22P02' instead of '0'.
select is(
  pg_temp.act_scalar(gen_random_uuid(), $sql$ select count(*)::text from storage.objects where bucket_id = 'sources' $sql$),
  '0',
  'an unrelated authenticated user sees none of the fixture rows (real, orphan or malformed), and the query never raises'
);

-- ---------------------------------------------------------------------------
-- 6) Delete policy behaviour, hit directly. A plain SQL DELETE on
-- storage.objects normally never reaches any RLS policy at all:
-- storage.protect_delete (a trigger Supabase's own storage schema installs,
-- not this PR's migration) rejects every direct DELETE outright with "Direct
-- deletion from storage tables is not allowed. Use the Storage API instead."
-- (confirmed while first writing this file) -- UNLESS the session first sets
-- the escape hatch that trigger's own body checks:
-- `coalesce(current_setting('storage.allow_delete_query', true), 'false') =
-- 'true'`. With that set, a DELETE as the real `authenticated` role finally
-- exercises *this PR's* delete policy instead of being stopped at the door.
--
-- This matters because tests/rls/storage.test.ts's "remove() reports 0
-- objects actually deleted" case does NOT prove the delete policy's own
-- shape: the Storage API's remove() resolves the object through the SELECT
-- policy first, so a leftover is already invisible there -- remove() finds
-- nothing to delete regardless of what the delete policy itself says. A
-- mutation that dropped the delete policy's own "existing sources row"
-- requirement (or its owner/editor restriction) entirely was not caught by
-- that RLS test for exactly this reason. This section is the one place that
-- actually drives storage.objects' delete policy on its own.
-- ---------------------------------------------------------------------------

-- Same shape as act_scalar, but also lifts storage.protect_delete's escape
-- hatch for the duration of the probe, and reports the number of rows the
-- DELETE actually affected (RLS denying a delete is 0 rows matched, not an
-- error -- same semantics act_delete_rowcount documented before this
-- rewrite). This GUC is set only inside this test file, never by application
-- code: it exists purely so a test can get past storage.protect_delete on
-- purpose.
create function pg_temp.act_delete_rowcount(actor_id uuid, probe text) returns text as $$
declare
  affected int;
  err_state text;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', actor_id, 'role', 'authenticated', 'is_anonymous', false)::text,
    true
  );
  set local storage.allow_delete_query = 'true';
  begin
    execute probe;
    get diagnostics affected = row_count;
  exception when others then
    get stacked diagnostics err_state = returned_sqlstate;
    reset role;
    return 'ERROR:' || err_state;
  end;
  reset role;
  return affected::text;
end;
$$ language plpgsql;

-- A real viewer, and three more real sources/objects dedicated to this
-- section (kept separate from real_path/orphan_path above, which section 5's
-- counts already depend on staying exactly as they were).
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_id from pg_temp.fixture), (select viewer_id from pg_temp.fixture), 'viewer'),
  'fixture: the owner adds a real viewer to the fixture notebook'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'owner-delete fixture source') returning id $f$,
    (select notebook_id from pg_temp.fixture)
  ),
  'fixture: the owner creates a second source, for the owner-can-delete case below'
);
update pg_temp.fixture set owner_delete_source_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
update pg_temp.fixture set owner_delete_path = notebook_id::text || '/' || owner_delete_source_id::text where owner_delete_source_id is not null;

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'viewer-target fixture source') returning id $f$,
    (select notebook_id from pg_temp.fixture)
  ),
  'fixture: the owner creates a third source, for the viewer-cannot-delete case below'
);
update pg_temp.fixture set viewer_target_source_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
update pg_temp.fixture set viewer_target_path = notebook_id::text || '/' || viewer_target_source_id::text where viewer_target_source_id is not null;

select pg_temp.act_insert_id(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (notebook_id, kind, title) values (%L, 'text', 'leftover fixture source') returning id $f$,
    (select notebook_id from pg_temp.fixture)
  ),
  'fixture: the owner creates a fourth source, whose row will be deleted below to create a real leftover'
);
update pg_temp.fixture set leftover_source_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
update pg_temp.fixture set leftover_path = notebook_id::text || '/' || leftover_source_id::text where leftover_source_id is not null;

select pg_temp.sql_lives(
  format($sql$ insert into storage.objects (bucket_id, name) values ('sources', %L) $sql$, (select owner_delete_path from pg_temp.fixture)),
  'fixture: insert the storage.objects row for the owner-can-delete case'
);
select pg_temp.sql_lives(
  format($sql$ insert into storage.objects (bucket_id, name) values ('sources', %L) $sql$, (select viewer_target_path from pg_temp.fixture)),
  'fixture: insert the storage.objects row for the viewer-cannot-delete case'
);
select pg_temp.sql_lives(
  format($sql$ insert into storage.objects (bucket_id, name) values ('sources', %L) $sql$, (select leftover_path from pg_temp.fixture)),
  'fixture: insert the storage.objects row that will be orphaned below'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format($f$ delete from public.sources where id = %L $f$, (select leftover_source_id from pg_temp.fixture)),
  'fixture: the owner deletes the leftover source row (its object stays behind in storage.objects)'
);

-- The owner deletes their own object whose sources row still exists: the
-- delete policy must let this through -- 1 row affected, and it is actually
-- gone afterwards.
select is(
  pg_temp.act_delete_rowcount(
    (select owner_id from pg_temp.fixture),
    format($sql$ delete from storage.objects where bucket_id = 'sources' and name = %L $sql$, (select owner_delete_path from pg_temp.fixture))
  ),
  '1',
  'the owner deletes their own object whose sources row still exists (1 row affected)'
);
select ok(
  coalesce(
    (select count(*) = 0 from storage.objects where bucket_id = 'sources' and name = (select owner_delete_path from pg_temp.fixture)),
    false
  ),
  'that object is actually gone afterwards'
);

-- The owner tries to delete the now-orphaned object (its sources row was
-- deleted above): the delete policy's "existing sources row" requirement
-- must deny this -- 0 rows affected, not an error, and the row is still
-- physically there.
select is(
  pg_temp.act_delete_rowcount(
    (select owner_id from pg_temp.fixture),
    format($sql$ delete from storage.objects where bucket_id = 'sources' and name = %L $sql$, (select leftover_path from pg_temp.fixture))
  ),
  '0',
  'the owner cannot delete the leftover object once its sources row is gone (0 rows affected, not an error)'
);
select ok(
  coalesce(
    (select count(*) = 1 from storage.objects where bucket_id = 'sources' and name = (select leftover_path from pg_temp.fixture)),
    false
  ),
  'the leftover object row is still physically present after the denied delete attempt'
);

-- A viewer tries to delete an object whose sources row DOES exist: the
-- delete policy's owner/editor-only restriction must deny this on its own,
-- independent of the sources-row check above -- 0 rows affected, not an
-- error, and the row is still physically there.
select is(
  pg_temp.act_delete_rowcount(
    (select viewer_id from pg_temp.fixture),
    format($sql$ delete from storage.objects where bucket_id = 'sources' and name = %L $sql$, (select viewer_target_path from pg_temp.fixture))
  ),
  '0',
  'a viewer cannot delete an object even though its sources row exists (0 rows affected, not an error) -- only owner/editor may delete'
);
select ok(
  coalesce(
    (select count(*) = 1 from storage.objects where bucket_id = 'sources' and name = (select viewer_target_path from pg_temp.fixture)),
    false
  ),
  'that object is still physically present after the viewer''s denied delete attempt'
);

select * from finish();

rollback;
