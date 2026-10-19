-- Catalog and behavioural tests for PR A1 (public.sources, public.chunks,
-- public.messages, public.match_chunks). 000_catalog.test.sql proves the
-- general invariants every table/function must satisfy (RLS on, no FOR ALL
-- policy, no stray SECURITY DEFINER, anon has nothing, etc); this file proves
-- PR A1's own contract: the extension and column shapes, the composite
-- foreign key between chunks and sources, the column-level grants, the
-- match_chunks function's exact properties, and the cascade behaviour on
-- delete.
--
-- None of this file's *structural* checks (existence, RLS flag, policy
-- shape, column type, index shape, grants, function properties) ever name
-- `extensions.vector`, `public.sources`, `public.chunks`, `public.messages`
-- or `public.match_chunks` inside a *statically parsed* SQL/PLpgSQL
-- expression. A `language sql` function's body is not parsed until first
-- called, so it is safe *at CREATE FUNCTION time* for the small text-only
-- helpers below (vector_literal etc) to mention application objects in a
-- *string* -- but a `language plpgsql` function body with
-- `plpgsql.check_function_bodies` on (the default) is validated, including
-- every identifier it names, at CREATE FUNCTION time itself. Before this
-- PR's migration lands, `extensions.vector` and the three new tables do not
-- exist, so any PL/pgSQL function that named them directly would fail to
-- even compile, aborting this file's whole transaction before a single
-- assertion ran. Every structural check below therefore goes through plain
-- pg_catalog introspection (to_regclass, pg_attribute, pg_index, pg_proc,
-- pg_policy, ...), which simply returns "not found" rather than erroring;
-- every behavioural check (actual DML, actual RPC calls) goes through
-- pg_temp.sql_lives/sql_throws/act_lives/act_throws/act_scalar, which wrap
-- one dynamically-built SQL string in its own PL/pgSQL exception block, so a
-- missing table/type/function surfaces as a normal pgTAP FAIL (e.g. 42P01
-- undefined_table where 23503 was expected) instead of crashing the suite.
--
-- "Safe at CREATE FUNCTION time" is a separate question from "callable by
-- every role at call time": this whole script connects as postgres, but
-- act_lives/act_throws/act_scalar run their probe after `set local role
-- authenticated`. A `language sql` pg_temp function created by postgres is
-- therefore not automatically callable from inside such a probe -- see the
-- EXECUTE grant next to pg_temp.vector_literal's definition below for why
-- and where that bit.
--
-- Fake embeddings: pg_temp.vector_literal(seed, noise) returns a vector
-- *as text* (dimension 1 fixed to 1, dimensions 2..1024 a seed/noise-
-- dependent small wobble), cast to extensions.vector only inside a
-- dynamically executed string. Cosine distance to the all-noise-zero query
-- vector grows with `noise` for a *fixed* `seed` -- strictly monotonically,
-- since scaling only the non-query dimensions by `noise` strictly increases
-- ||v|| and so strictly decreases cos-similarity 1/||v||. Across *different*
-- seeds the relationship is only approximate (each seed's deviation
-- direction has a slightly different norm), which is fine for the "small
-- noise group vs. large noise group" recall tests below but not precise
-- enough to predict an exact rank order -- the "exact top-8 of 60" test
-- further down deliberately reuses one fixed seed across every chunk so
-- noise order is guaranteed to equal distance order.
--
-- match_chunks does an *exact* nearest-neighbour search within the caller's
-- notebook (no approximate index, see the ADR this PR's migration links): no
-- planner GUCs need forcing for any of the tests below, and the recall tests'
-- point is no longer about defeating an approximate index at all -- it is
-- that `where notebook_id = p_notebook_id` has to actually restrict the
-- candidate set before (or equivalently to) the distance ordering and LIMIT,
-- not provide a global top-K across every notebook's chunks that then merely
-- gets *filtered* down, which could just as easily lose every one of the
-- caller's own, relevant rows if a foreign notebook has enough closer ones.

begin;

select plan(220);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Verbatim from 010_notebooks_memberships.test.sql (see that file's header
-- for why these three shapes exist): every probe always produces exactly one
-- pgTAP assertion, whatever the dynamic SQL in `probe` does.
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

-- Same shape as act_lives, but *without* `set local role authenticated`:
-- stays as postgres (table owner), who can still set an explicit `id` on
-- insert -- unlike `authenticated`, which lost that column grant as part of
-- the fix this migration is for ("permission denied for table sources"
-- otherwise). `request.jwt.claims` is still set so auth.uid()-driven
-- defaults (sources.created_by, messages.user_id) resolve to the intended
-- actor regardless of role; auth.uid() reads that GUC, not the current
-- database role. This also bypasses RLS entirely (postgres is superuser),
-- which is fine here: this helper is for building *fixtures*, never for the
-- tests that specifically prove an actor's own insert/update/delete right
-- (those stay on act_lives/act_throws, with the real role switch).
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

-- Runs `probe` (expected to return exactly one text-castable scalar) as
-- `actor_id` under role authenticated. match_chunks does an exact search (no
-- approximate index), so unlike an ANN-index design this needs no planner
-- GUCs forced one way or another -- the result is the same regardless of
-- which plan the optimizer happens to pick. On error, returns
-- 'ERROR:<sqlstate>' instead of raising, so the caller can assert on the
-- scalar value either way.
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

-- Same shape as act_lives, but `probe` is expected to be an
-- "INSERT ... RETURNING id" statement, for chunks specifically: chunks has no
-- client-settable `id` column grant (unlike sources/notebooks), so a chunk
-- referenced again later (e.g. as message_citations.chunk_id) can only be
-- captured via RETURNING, never pre-generated.
--
-- This function's own return value is still the pgTAP line text (exactly
-- like act_lives), NOT the captured id: PERFORM, unlike SELECT, deliberately
-- discards a query's result without ever sending it to the client, so a
-- nested `perform ok(...)` here would still advance pgTAP's internal test
-- counter (its bookkeeping happens inside ok() itself) while never actually
-- printing the "ok N - description" line psql needs to emit for pg_prove to
-- read -- found the hard way: a desync between pgTAP's counter and the lines
-- pg_prove actually sees, reported as "Tests out of sequence". The captured
-- id instead goes out via a side-channel session GUC (the same
-- `set_config`/`current_setting` mechanism this file already uses for
-- request.jwt.claims), consumed by a plain follow-up statement -- see its
-- call sites below.
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

-- Same shape as act_scalar but as the real `anon` role, with no JWT claims
-- override -- exercises the genuinely unauthenticated PostgREST path.
create function pg_temp.anon_scalar(probe text) returns text as $$
declare
  result text;
  err_state text;
begin
  set local role anon;
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

-- Same shape as act_lives/sql_throws, but with no role switch at all (runs
-- as whatever role is already current -- postgres, for every caller in this
-- file): used for plain DDL like `alter table ... disable/enable trigger`,
-- which an unprivileged `authenticated` role could never run anyway.
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

-- Same shape as act_scalar but with no role switch (runs as postgres): used
-- where a probe needs the real id-settable-by-postgres path (id still has an
-- ordinary column grant to postgres as table owner; only `authenticated`
-- loses it), independent of the authenticated-role privilege question that
-- act_scalar/act_throws test separately.
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

-- A fake 1024-dim embedding, as text ("[1,v2,v3,...]"), dimension 1 fixed to
-- 1 and every later dimension a small seed/noise-dependent wobble. Pure SQL,
-- no application-object reference, safe to create unconditionally.
--
-- "Safe to create" is not the same as "callable by every role", and this
-- function is both created *and called* while this script is still connected
-- as postgres: three bulk-insert probes below (the match_access/match_clamp/
-- recall-foreign fixtures) call it from *inside* a dynamically-executed
-- string that runs under `set local role authenticated` (see act_lives), not
-- just from a format() argument evaluated by postgres beforehand. The
-- migration's global `alter default privileges for role postgres revoke
-- execute on functions from public` (needed so a stray new function never
-- defaults to PUBLIC-executable) applies to every function postgres creates
-- in *any* schema, pg_temp included -- so without the explicit grant below,
-- those three probes fail at runtime with "permission denied for function
-- vector_literal", not at CREATE FUNCTION time. Granting EXECUTE here is a
-- test-only fix (this is a pg_temp function, gone at rollback); the
-- application migration itself is never touched for this.
create function pg_temp.vector_literal(seed int, noise double precision) returns text as $$
  select '[1,' || string_agg((noise * sin(seed * (i + 1)))::text, ',' order by i) || ']'
  from generate_series(1, 1023) as i;
$$ language sql;
grant execute on function pg_temp.vector_literal(int, double precision) to authenticated;

-- Catalog-only structural helpers (never error on a missing object: a filter
-- against pg_class/pg_policy/pg_proc simply returns no rows / false).
create function pg_temp.has_permissive_policy(tbl text, cmd text) returns boolean as $$
  select exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = tbl
      and p.polpermissive
      and p.polcmd in (cmd, '*')
  );
$$ language sql;

create function pg_temp.has_restrictive_anon_block(tbl text, cmd text) returns boolean as $$
  select exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = tbl
      and not p.polpermissive
      and p.polcmd = cmd
      and (
        coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%is_anonymous%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%is_anonymous%'
      )
  );
$$ language sql;

create function pg_temp.match_chunks_oid() returns oid as $$
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'match_chunks'
  limit 1;
$$ language sql;

-- Generic niladic-function lookup, reused for the two message_citations
-- trigger functions below.
create function pg_temp.proc_oid(schema_name text, proc_name text) returns oid as $$
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = schema_name and p.proname = proc_name
  limit 1;
$$ language sql;

-- ---------------------------------------------------------------------------
-- 1) Existence, RLS, policy shape
-- ---------------------------------------------------------------------------

select ok(to_regclass('public.sources') is not null, 'public.sources exists');
select ok(to_regclass('public.chunks') is not null, 'public.chunks exists');
select ok(to_regclass('public.messages') is not null, 'public.messages exists');

select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'sources'), false),
  'RLS is enabled on public.sources'
);
select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'chunks'), false),
  'RLS is enabled on public.chunks'
);
select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'messages'), false),
  'RLS is enabled on public.messages'
);

select is_empty(
  $sql$
    select p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('sources', 'chunks', 'messages', 'message_citations')
      and p.polcmd = '*'
  $sql$,
  'no FOR ALL policy exists on sources, chunks, messages or message_citations'
);

select ok(pg_temp.has_permissive_policy('sources', 'r'), 'sources has a permissive select policy');
select ok(pg_temp.has_permissive_policy('sources', 'a'), 'sources has a permissive insert policy');
select ok(pg_temp.has_permissive_policy('sources', 'w'), 'sources has a permissive update policy');
select ok(pg_temp.has_permissive_policy('sources', 'd'), 'sources has a permissive delete policy');

select ok(pg_temp.has_permissive_policy('chunks', 'r'), 'chunks has a permissive select policy');
select ok(pg_temp.has_permissive_policy('chunks', 'a'), 'chunks has a permissive insert policy');
select ok(pg_temp.has_permissive_policy('chunks', 'd'), 'chunks has a permissive delete policy');

select ok(pg_temp.has_permissive_policy('messages', 'r'), 'messages has a permissive select policy');
select ok(pg_temp.has_permissive_policy('messages', 'a'), 'messages has a permissive insert policy');
select ok(pg_temp.has_permissive_policy('messages', 'd'), 'messages has a permissive delete policy');

select ok(
  pg_temp.has_restrictive_anon_block('sources', 'a'),
  'sources has a restrictive is_anonymous-blocking policy for insert'
);
select ok(
  pg_temp.has_restrictive_anon_block('sources', 'w'),
  'sources has a restrictive is_anonymous-blocking policy for update'
);
select ok(
  pg_temp.has_restrictive_anon_block('sources', 'd'),
  'sources has a restrictive is_anonymous-blocking policy for delete'
);
select ok(
  pg_temp.has_restrictive_anon_block('chunks', 'a'),
  'chunks has a restrictive is_anonymous-blocking policy for insert'
);
select ok(
  pg_temp.has_restrictive_anon_block('chunks', 'd'),
  'chunks has a restrictive is_anonymous-blocking policy for delete'
);

-- Citations redesign: citations move out of messages.citations (jsonb) into
-- their own table. Like messages, anonymous-signin users may insert their
-- own citations (demo chat) -- no restrictive is_anonymous-blocking policy
-- here, unlike sources/chunks.
select ok(to_regclass('public.message_citations') is not null, 'public.message_citations exists');
select ok(
  coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'message_citations'), false),
  'RLS is enabled on public.message_citations'
);
select ok(pg_temp.has_permissive_policy('message_citations', 'r'), 'message_citations has a permissive select policy');
select ok(pg_temp.has_permissive_policy('message_citations', 'a'), 'message_citations has a permissive insert policy');
select ok(pg_temp.has_permissive_policy('message_citations', 'w'), 'message_citations has a permissive update policy');
select ok(pg_temp.has_permissive_policy('message_citations', 'd'), 'message_citations has a permissive delete policy');

-- ---------------------------------------------------------------------------
-- 2) Extension
-- ---------------------------------------------------------------------------

select ok(
  exists (
    select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector' and n.nspname = 'extensions'
  ),
  'extension vector is installed in schema extensions'
);
select ok(
  coalesce(
    (select split_part(e.extversion, '.', 1)::int * 100 + split_part(e.extversion, '.', 2)::int
     from pg_extension e where e.extname = 'vector') >= 8,
    false
  ),
  'vector extension version is >= 0.8'
);

-- ---------------------------------------------------------------------------
-- 3) chunks.embedding shape and indexes
-- ---------------------------------------------------------------------------

select ok(
  coalesce(
    (select t.typname = 'vector' and tn.nspname = 'extensions' and a.atttypmod = 1024
     from pg_attribute a
     join pg_type t on t.oid = a.atttypid
     join pg_namespace tn on tn.oid = t.typnamespace
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'chunks' and a.attname = 'embedding' and not a.attisdropped),
    false
  ),
  'chunks.embedding is extensions.vector(1024)'
);

-- Deliberate design decision (not a gap): match_chunks does an exact search
-- within the caller's notebook, not an approximate one -- HNSW/ivfflat gave
-- no recall guarantee (confirmed against a real pgvector instance: identical
-- test data returned 0 of 5 relevant rows after enough writes/deletes
-- changed the HNSW graph, and separately after ~15 repeated pgTAP runs in
-- this very suite). A future PR adding an approximate index back needs a new
-- ADR, not a silent migration -- this assertion pins "no such index exists"
-- so that migration would have to touch this test too.
select ok(
  not exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    join pg_am am on am.oid = ic.relam
    where n.nspname = 'public' and tc.relname = 'chunks'
      and am.amname in ('hnsw', 'ivfflat')
  ),
  'no index on public.chunks uses an approximate vector access method (hnsw or ivfflat)'
);

select ok(
  exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    join pg_am am on am.oid = ic.relam
    join pg_attribute a on a.attrelid = tc.oid and a.attnum = i.indkey[0]
    where n.nspname = 'public' and tc.relname = 'chunks'
      and am.amname = 'btree' and a.attname = 'notebook_id' and i.indnkeyatts = 1
  ),
  'chunks has a btree index on notebook_id'
);

select ok(
  exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class fc on fc.oid = con.confrelid
    where n.nspname = 'public' and c.relname = 'chunks' and con.contype = 'f' and fc.relname = 'sources'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['source_id', 'notebook_id']
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.confkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
      ) = array['id', 'notebook_id']
  ),
  'chunks has a composite foreign key (source_id, notebook_id) -> sources(id, notebook_id)'
);

-- Reviewer finding: per-user message history (select filters on user_id) and
-- the ops/ingestion views that will list sources by uploader both need an
-- index, not a sequential scan, to stay cheap as these tables grow.
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    join pg_attribute a on a.attrelid = tc.oid and a.attnum = i.indkey[0]
    where n.nspname = 'public' and tc.relname = 'messages' and a.attname = 'user_id'
  ),
  'public.messages has an index whose first column is user_id'
);
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    join pg_attribute a on a.attrelid = tc.oid and a.attnum = i.indkey[0]
    where n.nspname = 'public' and tc.relname = 'sources' and a.attname = 'created_by'
  ),
  'public.sources has an index whose first column is created_by'
);

-- Second Codex finding (PR #19): storage_path is now a *stored generated
-- column* (notebook_id::text || '/' || id::text), not a CHECK constraint --
-- id itself is globally unique (PK), which already makes storage_path
-- unique in practice, but a plain UNIQUE constraint on storage_path is still
-- required as a backstop independent of that reasoning (e.g. against a
-- future change to the generation expression).
select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sources' and con.contype = 'u'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['storage_path']
  ),
  'sources has a unique constraint on storage_path'
);

-- attgenerated = 's' means STORED GENERATED ALWAYS AS (...); the generation
-- expression itself lives in the column's pg_attrdef entry, same storage
-- slot Postgres uses for ordinary DEFAULT expressions. Checked loosely (every
-- part mentioned, not an exact deparsed-text match) since Postgres's
-- deparser is free to add its own parenthesisation/casts when rendering the
-- expression back as text.
select ok(
  coalesce(
    (select a.attgenerated = 's'
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'sources' and a.attname = 'storage_path' and not a.attisdropped),
    false
  ),
  'sources.storage_path is a stored generated column (attgenerated = ''s'')'
);
select ok(
  coalesce(
    (select pg_get_expr(d.adbin, d.adrelid) ilike '%notebook_id%'
       and pg_get_expr(d.adbin, d.adrelid) ilike '%id%'
       and pg_get_expr(d.adbin, d.adrelid) like '%/%'
     from pg_attrdef d
     join pg_class c on c.oid = d.adrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where n.nspname = 'public' and c.relname = 'sources' and a.attname = 'storage_path'),
    false
  ),
  'sources.storage_path''s generation expression references notebook_id, id and a ''/'' separator'
);

-- ---------------------------------------------------------------------------
-- 4) Grants
-- ---------------------------------------------------------------------------

select ok(
  not (
    coalesce(has_table_privilege('anon', to_regclass('public.sources'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'), false)
    or coalesce(has_any_column_privilege('anon', to_regclass('public.sources'), 'SELECT,INSERT,UPDATE,REFERENCES'), false)
  ),
  'anon has no privilege on public.sources'
);
select ok(
  not (
    coalesce(has_table_privilege('anon', to_regclass('public.chunks'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'), false)
    or coalesce(has_any_column_privilege('anon', to_regclass('public.chunks'), 'SELECT,INSERT,UPDATE,REFERENCES'), false)
  ),
  'anon has no privilege on public.chunks'
);
select ok(
  not (
    coalesce(has_table_privilege('anon', to_regclass('public.messages'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'), false)
    or coalesce(has_any_column_privilege('anon', to_regclass('public.messages'), 'SELECT,INSERT,UPDATE,REFERENCES'), false)
  ),
  'anon has no privilege on public.messages'
);

select ok(
  not coalesce(has_table_privilege('authenticated', to_regclass('public.chunks'), 'UPDATE'), false),
  'authenticated has no table-level UPDATE on public.chunks'
);
select ok(
  not coalesce(has_any_column_privilege('authenticated', to_regclass('public.chunks'), 'UPDATE'), false),
  'authenticated has no column-level UPDATE on public.chunks'
);
select ok(
  not coalesce(has_table_privilege('authenticated', to_regclass('public.messages'), 'UPDATE'), false),
  'authenticated has no table-level UPDATE on public.messages'
);
select ok(
  not coalesce(has_any_column_privilege('authenticated', to_regclass('public.messages'), 'UPDATE'), false),
  'authenticated has no column-level UPDATE on public.messages'
);

select ok(
  coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'title', 'UPDATE'), false),
  'authenticated can update sources.title'
);
select ok(
  coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'status', 'UPDATE'), false),
  'authenticated can update sources.status'
);
select ok(
  not coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'notebook_id', 'UPDATE'), false),
  'authenticated cannot update sources.notebook_id'
);
select ok(
  not coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'storage_path', 'UPDATE'), false),
  'authenticated cannot update sources.storage_path'
);
select ok(
  not coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'kind', 'UPDATE'), false),
  'authenticated cannot update sources.kind'
);
select ok(
  not coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'id', 'UPDATE'), false),
  'authenticated cannot update sources.id'
);

-- Second Codex finding (PR #19): id and storage_path are both server-assigned
-- now -- the insert column grant is notebook_id, kind, title only. A
-- client-chosen id previously let an editor delete a source and recreate one
-- with the same id, rebinding whatever Storage object was left at that path.
select ok(
  not coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'id', 'INSERT'), false),
  'authenticated cannot insert sources.id'
);
select ok(
  not coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'storage_path', 'INSERT'), false),
  'authenticated cannot insert sources.storage_path'
);
select ok(
  coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'notebook_id', 'INSERT'), false)
  and coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'kind', 'INSERT'), false)
  and coalesce(has_column_privilege('authenticated', to_regclass('public.sources'), 'title', 'INSERT'), false),
  'authenticated can insert notebook_id, kind and title'
);

-- ---------------------------------------------------------------------------
-- 5) match_chunks: function properties
-- ---------------------------------------------------------------------------

select ok(pg_temp.match_chunks_oid() is not null, 'public.match_chunks exists');
select ok(
  not coalesce((select prosecdef from pg_proc where oid = pg_temp.match_chunks_oid()), true),
  'match_chunks is security invoker (not security definer)'
);
select ok(
  coalesce((select provolatile = 's' from pg_proc where oid = pg_temp.match_chunks_oid()), false),
  'match_chunks is stable'
);
-- Exactly {search_path=""} -- not just "contains it" -- so a stray extra SET
-- option (like the retired hnsw.iterative_scan one) would fail this test too,
-- not just go unnoticed.
select ok(
  coalesce(
    (select proconfig = array['search_path=""'] from pg_proc where oid = pg_temp.match_chunks_oid()),
    false
  ),
  'match_chunks''s proconfig is exactly {search_path=""}'
);
select ok(
  not coalesce(has_function_privilege('anon', pg_temp.match_chunks_oid(), 'EXECUTE'), false),
  'anon cannot execute match_chunks'
);
select ok(
  coalesce(has_function_privilege('authenticated', pg_temp.match_chunks_oid(), 'EXECUTE'), false),
  'authenticated can execute match_chunks'
);

-- ---------------------------------------------------------------------------
-- 5b) message_citations: grants, PK, FKs, index, unique constraints,
-- trigger functions and the triggers themselves
-- ---------------------------------------------------------------------------

select ok(
  not (
    coalesce(has_table_privilege('anon', to_regclass('public.message_citations'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'), false)
    or coalesce(has_any_column_privilege('anon', to_regclass('public.message_citations'), 'SELECT,INSERT,UPDATE,REFERENCES'), false)
  ),
  'anon has no privilege on public.message_citations'
);
select ok(
  not coalesce(has_table_privilege('authenticated', to_regclass('public.message_citations'), 'UPDATE'), false),
  'authenticated has no table-level UPDATE on public.message_citations'
);
select ok(
  not coalesce(has_any_column_privilege('authenticated', to_regclass('public.message_citations'), 'UPDATE'), false),
  'authenticated has no column-level UPDATE on public.message_citations'
);
select ok(
  coalesce(has_table_privilege('authenticated', to_regclass('public.message_citations'), 'SELECT,INSERT,DELETE'), false),
  'authenticated has SELECT, INSERT and DELETE on public.message_citations'
);
select ok(
  coalesce(has_column_privilege('authenticated', to_regclass('public.message_citations'), 'chunk_id', 'INSERT'), false)
  and coalesce(has_column_privilege('authenticated', to_regclass('public.message_citations'), 'quote', 'INSERT'), false)
  and coalesce(has_column_privilege('authenticated', to_regclass('public.message_citations'), 'ordinal', 'INSERT'), false)
  and coalesce(has_column_privilege('authenticated', to_regclass('public.message_citations'), 'message_id', 'INSERT'), false)
  and coalesce(has_column_privilege('authenticated', to_regclass('public.message_citations'), 'notebook_id', 'INSERT'), false),
  'authenticated can insert message_id, notebook_id, ordinal, chunk_id and quote'
);

select ok(
  exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'message_citations' and con.contype = 'p'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['message_id', 'ordinal']
  ),
  'message_citations has primary key (message_id, ordinal)'
);

select ok(
  exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class fc on fc.oid = con.confrelid
    where n.nspname = 'public' and c.relname = 'message_citations' and con.contype = 'f'
      and fc.relname = 'messages' and con.confdeltype = 'c'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['message_id', 'notebook_id']
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.confkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
      ) = array['id', 'notebook_id']
  ),
  'message_citations has foreign key (message_id, notebook_id) -> messages(id, notebook_id) ON DELETE CASCADE'
);

-- ON DELETE SET NULL with an explicit column list (chunk_id only, not
-- notebook_id) is stored as pg_constraint.confdelsetcols, not just confdeltype.
select ok(
  exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class fc on fc.oid = con.confrelid
    where n.nspname = 'public' and c.relname = 'message_citations' and con.contype = 'f'
      and fc.relname = 'chunks' and con.confdeltype = 'n'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['chunk_id', 'notebook_id']
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.confkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
      ) = array['id', 'notebook_id']
      and (
        select array_agg(a.attname::text)
        from unnest(con.confdelsetcols) as colnum
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = colnum
      ) = array['chunk_id']
  ),
  'message_citations has foreign key (chunk_id, notebook_id) -> chunks(id, notebook_id) ON DELETE SET NULL (chunk_id)'
);

select ok(
  exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    join pg_attribute a on a.attrelid = tc.oid and a.attnum = i.indkey[0]
    where n.nspname = 'public' and tc.relname = 'message_citations' and a.attname = 'chunk_id'
  ),
  'message_citations has an index whose first column is chunk_id'
);

select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'chunks' and con.contype = 'u'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['id', 'notebook_id']
  ),
  'chunks has a unique constraint on (id, notebook_id)'
);
select ok(
  exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'messages' and con.contype = 'u'
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = array['id', 'notebook_id']
  ),
  'messages has a unique constraint on (id, notebook_id)'
);

-- Trigger functions: private.clear_citation_quote() (invoker) and
-- private.redact_cited_answers() (definer, allowlisted in 000_catalog.test.sql).
select ok(pg_temp.proc_oid('private', 'clear_citation_quote') is not null, 'private.clear_citation_quote() exists');
select ok(
  not coalesce((select prosecdef from pg_proc where oid = pg_temp.proc_oid('private', 'clear_citation_quote')), true),
  'private.clear_citation_quote() is security invoker'
);
select ok(
  coalesce((select prorettype = 'trigger'::regtype from pg_proc where oid = pg_temp.proc_oid('private', 'clear_citation_quote')), false),
  'private.clear_citation_quote() returns trigger'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(proconfig, '{}')) from pg_proc where oid = pg_temp.proc_oid('private', 'clear_citation_quote')),
    false
  ),
  'private.clear_citation_quote() sets search_path to the empty string'
);
select ok(
  not coalesce(has_function_privilege('public', pg_temp.proc_oid('private', 'clear_citation_quote'), 'EXECUTE'), false),
  'public cannot execute private.clear_citation_quote()'
);
select ok(
  not coalesce(has_function_privilege('anon', pg_temp.proc_oid('private', 'clear_citation_quote'), 'EXECUTE'), false),
  'anon cannot execute private.clear_citation_quote()'
);
select ok(
  not coalesce(has_function_privilege('authenticated', pg_temp.proc_oid('private', 'clear_citation_quote'), 'EXECUTE'), false),
  'authenticated cannot execute private.clear_citation_quote()'
);

select ok(pg_temp.proc_oid('private', 'redact_cited_answers') is not null, 'private.redact_cited_answers() exists');
select ok(
  coalesce((select prosecdef from pg_proc where oid = pg_temp.proc_oid('private', 'redact_cited_answers')), false),
  'private.redact_cited_answers() is security definer'
);
select ok(
  coalesce((select prorettype = 'trigger'::regtype from pg_proc where oid = pg_temp.proc_oid('private', 'redact_cited_answers')), false),
  'private.redact_cited_answers() returns trigger'
);
select ok(
  coalesce(
    (select 'search_path=""' = any(coalesce(proconfig, '{}')) from pg_proc where oid = pg_temp.proc_oid('private', 'redact_cited_answers')),
    false
  ),
  'private.redact_cited_answers() sets search_path to the empty string'
);
select ok(
  not coalesce(has_function_privilege('public', pg_temp.proc_oid('private', 'redact_cited_answers'), 'EXECUTE'), false),
  'public cannot execute private.redact_cited_answers()'
);
select ok(
  not coalesce(has_function_privilege('anon', pg_temp.proc_oid('private', 'redact_cited_answers'), 'EXECUTE'), false),
  'anon cannot execute private.redact_cited_answers()'
);
select ok(
  not coalesce(has_function_privilege('authenticated', pg_temp.proc_oid('private', 'redact_cited_answers'), 'EXECUTE'), false),
  'authenticated cannot execute private.redact_cited_answers()'
);

-- Triggers: BEFORE UPDATE OF chunk_id -> clear_citation_quote (tgtype bit 0x02
-- BEFORE, bit 0x10 UPDATE); AFTER UPDATE OF chunk_id WHEN (...) ->
-- redact_cited_answers (tgtype bit 0x10 UPDATE, BEFORE bit unset = AFTER).
-- "UPDATE OF chunk_id" triggers store the watched column's attnum in tgattr.
select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'chunk_id'
    where n.nspname = 'public' and c.relname = 'message_citations'
      and t.tgfoid = pg_temp.proc_oid('private', 'clear_citation_quote')
      and not t.tgisinternal
      and (t.tgtype & 2) = 2  -- BEFORE
      and (t.tgtype & 16) = 16 -- UPDATE
      and a.attnum = any(t.tgattr)
  ),
  'message_citations has a BEFORE UPDATE OF chunk_id trigger calling private.clear_citation_quote()'
);
select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'chunk_id'
    where n.nspname = 'public' and c.relname = 'message_citations'
      and t.tgfoid = pg_temp.proc_oid('private', 'redact_cited_answers')
      and not t.tgisinternal
      and (t.tgtype & 2) = 0  -- AFTER (BEFORE bit unset)
      and (t.tgtype & 16) = 16 -- UPDATE
      and a.attnum = any(t.tgattr)
      and t.tgqual is not null -- has a WHEN clause
  ),
  'message_citations has an AFTER UPDATE OF chunk_id ... WHEN (...) trigger calling private.redact_cited_answers()'
);

-- ---------------------------------------------------------------------------
-- 6) Behavioural fixtures: a real owner, two notebooks, one source
-- ---------------------------------------------------------------------------

-- Every source id a later statement needs to refer back to (to insert its
-- chunks, or to delete it) is generated up front here and reused by value,
-- rather than read back with a plain `select ... from public.sources`
-- afterwards -- a plain top-level SELECT against a table that does not exist
-- yet would raise 42P01 *outside* any of the exception-safe pg_temp helpers
-- above, aborting this whole file's transaction instead of producing a normal
-- pgTAP FAIL (confirmed the hard way while developing this file).
create table pg_temp.fixture (
  owner_id uuid not null,
  notebook_a uuid not null,
  notebook_b uuid not null,
  source_a uuid not null,
  notebook_cascade uuid not null,
  source_cascade uuid not null,
  chunk_cascade uuid,
  message_cascade uuid not null,
  editor_cascade_id uuid not null,
  message_cascade_2 uuid not null,
  notebook_cascade_keep uuid not null,
  notebook_source_cascade uuid not null,
  source_doomed uuid not null,
  stranger_id uuid not null,
  notebook_match_access uuid not null,
  source_match_access uuid not null,
  notebook_match_clamp uuid not null,
  source_match_clamp uuid not null,
  notebook_match_recall_own uuid not null,
  source_recall_own uuid not null,
  notebook_match_recall_foreign uuid not null,
  source_recall_foreign uuid not null,
  foreign_owner_id uuid not null,
  notebook_match_exact uuid not null,
  source_match_exact uuid not null
);
insert into pg_temp.fixture (
  owner_id, notebook_a, notebook_b, source_a,
  notebook_cascade, source_cascade, message_cascade, editor_cascade_id, message_cascade_2,
  notebook_cascade_keep, notebook_source_cascade, source_doomed,
  stranger_id, notebook_match_access, source_match_access, notebook_match_clamp, source_match_clamp,
  notebook_match_recall_own, source_recall_own, notebook_match_recall_foreign, source_recall_foreign,
  foreign_owner_id, notebook_match_exact, source_match_exact
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (select unnest(array[owner_id, stranger_id, foreign_owner_id, editor_cascade_id]) as u from pg_temp.fixture) as users;

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_a from pg_temp.fixture), 'fixture A'),
  'fixture setup: owner creates notebook A'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_b from pg_temp.fixture), 'fixture B'),
  'fixture setup: owner creates notebook B'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'fixture source') $f$,
    (select source_a from pg_temp.fixture), (select notebook_a from pg_temp.fixture)
  ),
  'fixture setup: owner creates source A in notebook A'
);

-- ---------------------------------------------------------------------------
-- 7) Behavioural: composite FK and the storage_path check constraint
-- ---------------------------------------------------------------------------

select pg_temp.act_throws(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'mismatched chunk', %L::extensions.vector) $f$,
    (select notebook_b from pg_temp.fixture), (select source_a from pg_temp.fixture),
    pg_temp.vector_literal(1, 0.01)
  ),
  '23503',
  'a chunk whose notebook_id does not match its source''s notebook_id raises 23503'
);

-- Second Codex finding (PR #19, on top of the first): storage_path becomes a
-- *stored generated column* (`notebook_id::text || '/' || id::text`) and id
-- comes only from its gen_random_uuid() default -- neither is in the insert
-- column grant any more (notebook_id, kind, title only). A client-chosen id
-- previously let an editor delete a source and recreate one with the same
-- id, rebinding whatever Storage object was left at that path. Naming
-- storage_path at all in an INSERT is now a *semantic* error (Postgres
-- rejects writing to a generated column at parse-analysis time, SQLSTATE
-- 428C9 "generated_always"), independent of role/privilege -- confirmed by
-- running this as plain postgres, who still owns the table and could
-- otherwise set any ordinary column.
select pg_temp.sql_throws(
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, storage_path)
        values (%L, %L, 'text', 'explicit storage_path', %L) $f$,
    gen_random_uuid(), (select notebook_a from pg_temp.fixture),
    (select notebook_a from pg_temp.fixture) || '/explicit'
  ),
  '428C9',
  'naming storage_path explicitly in an INSERT raises 428C9 (generated_always), even for a well-formed-looking value'
);
-- A plain insert (no storage_path; id is still settable by postgres, the
-- table owner -- only `authenticated` loses that column grant, checked
-- separately below) computes the generated value correctly.
select ok(
  (select r = 'true'
   from (select pg_temp.sql_scalar(
     format(
       $f$ insert into public.sources (id, notebook_id, kind, title)
           values (%1$L, %2$L, 'text', 'generated path source')
           returning (storage_path = %2$L || '/' || %1$L)::text $f$,
       gen_random_uuid(), (select notebook_a from pg_temp.fixture)
     )
   ) as r) s),
  'inserting without storage_path computes it as exactly <notebook_id>/<id>'
);

-- Reviewer finding: chunks.content needs an upper bound (8000 characters).
select pg_temp.act_throws(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 20, %L, %L::extensions.vector) $f$,
    (select notebook_a from pg_temp.fixture), (select source_a from pg_temp.fixture),
    repeat('x', 8001), pg_temp.vector_literal(4, 0.01)
  ),
  '23514',
  'chunk content longer than 8000 characters raises 23514'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 21, %L, %L::extensions.vector) $f$,
    (select notebook_a from pg_temp.fixture), (select source_a from pg_temp.fixture),
    repeat('x', 8000), pg_temp.vector_literal(5, 0.01)
  ),
  'chunk content of exactly 8000 characters is accepted'
);

-- ---------------------------------------------------------------------------
-- 7b) Behavioural: message_citations column checks
-- ---------------------------------------------------------------------------
--
-- CHECK constraints (and NOT NULL) are enforced synchronously while a row is
-- being inserted; foreign-key enforcement runs afterward, via an AFTER ROW
-- trigger. So a CHECK violation is raised before Postgres ever looks at
-- whether message_id/chunk_id reference anything real -- these three probes
-- can therefore use throwaway, non-existent uuids and still deterministically
-- get 23514, with no membership/message/chunk fixture needed at all. Run as
-- postgres (sql_throws, no role switch): postgres bypasses RLS entirely as
-- superuser, so this is purely about the CHECK constraints, independent of
-- any policy.
select pg_temp.sql_throws(
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote)
        values (%L, %L, 0, %L, 'x') $f$,
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
  ),
  '23514',
  'message_citations.ordinal must be >= 1 (0 raises 23514)'
);
select pg_temp.sql_throws(
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote)
        values (%L, %L, 21, %L, 'x') $f$,
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
  ),
  '23514',
  'message_citations.ordinal must be <= 20 (21 raises 23514)'
);
select pg_temp.sql_throws(
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote)
        values (%L, %L, 1, %L, %L) $f$,
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), repeat('x', 2001)
  ),
  '23514',
  'message_citations.quote longer than 2000 characters raises 23514'
);
select pg_temp.sql_throws(
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote)
        values (%L, %L, 1, %L, null) $f$,
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
  ),
  '23514',
  'message_citations with chunk_id set and quote null violates (chunk_id is null) = (quote is null)'
);

-- ---------------------------------------------------------------------------
-- 7c) Behavioural: a trigger function cannot be called directly
-- ---------------------------------------------------------------------------
--
-- As authenticated, EXECUTE is revoked outright, so the privilege check fails
-- before Postgres would even get to "this is a trigger function" (42501). As
-- postgres (superuser, bypasses EXECUTE grants entirely), the call still
-- fails, but for the structurally different reason the human's plan calls
-- out: trigger functions can only be invoked by the trigger machinery, never
-- directly (0A000, feature_not_supported).
select ok(
  (select r in ('ERROR:42501', 'ERROR:0A000')
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     'select private.redact_cited_answers()'
   ) as r) s),
  'authenticated cannot call private.redact_cited_answers() directly (42501 or 0A000)'
);
select pg_temp.sql_throws(
  'select private.redact_cited_answers()',
  '0A000',
  'postgres cannot call private.redact_cited_answers() directly either (trigger functions can only be called as triggers)'
);

-- ---------------------------------------------------------------------------
-- 7d) Behavioural fixture: owner/editor/viewer, a notebook, chunks in their
-- own sources, and messages+citations for the fail-safe and cross-user
-- redaction tests below.
-- ---------------------------------------------------------------------------

create table pg_temp.citation_fixture (
  owner_id uuid not null,
  editor_id uuid not null,
  viewer_id uuid not null,
  notebook_id uuid not null,
  source_failsafe uuid not null,
  chunk_failsafe uuid,
  message_failsafe uuid not null,
  source_x uuid not null,
  chunk_x uuid,
  source_y uuid not null,
  chunk_y uuid,
  message_question uuid not null,
  message_answer uuid not null,
  message_owner_answer uuid not null
);
insert into pg_temp.citation_fixture (
  owner_id, editor_id, viewer_id, notebook_id,
  source_failsafe, message_failsafe, source_x, source_y,
  message_question, message_answer, message_owner_answer
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (select unnest(array[owner_id, editor_id, viewer_id]) as u from pg_temp.citation_fixture) as users;

select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_id from pg_temp.citation_fixture), 'citation fixture notebook'),
  'citation fixture: owner creates the notebook'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_id from pg_temp.citation_fixture), (select editor_id from pg_temp.citation_fixture), 'editor'),
  'citation fixture: owner adds the editor'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_id from pg_temp.citation_fixture), (select viewer_id from pg_temp.citation_fixture), 'viewer'),
  'citation fixture: owner adds the viewer'
);

select pg_temp.setup_insert(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'failsafe source') $f$,
    (select source_failsafe from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: owner creates the fail-safe source'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'failsafe chunk', %L::extensions.vector) returning id $f$,
    (select notebook_id from pg_temp.citation_fixture), (select source_failsafe from pg_temp.citation_fixture),
    pg_temp.vector_literal(20, 0.01)
  ),
  'citation fixture: owner creates the fail-safe chunk'
);
update pg_temp.citation_fixture
set chunk_failsafe = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'failsafe answer') $f$,
    (select message_failsafe from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: owner creates the fail-safe message'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'failsafe quote') $f$,
    (select message_failsafe from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture),
    (select chunk_failsafe from pg_temp.citation_fixture)
  ),
  'citation fixture: owner creates the fail-safe citation'
);
-- ordinal 20 is the top of the allowed 1..20 range: needs real FK targets
-- (unlike the throwaway-uuid checks above), since a successful INSERT is not
-- short-circuited by a CHECK failure before FK validation runs -- reuses the
-- fail-safe message/chunk, a second, distinct citation row (ordinal 20, not
-- 1) for the same message.
select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 20, %L, 'ordinal 20') $f$,
    (select message_failsafe from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture),
    (select chunk_failsafe from pg_temp.citation_fixture)
  ),
  'message_citations.ordinal of exactly 20 is accepted'
);

select pg_temp.setup_insert(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'source X') $f$,
    (select source_x from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: owner creates source X'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'chunk X', %L::extensions.vector) returning id $f$,
    (select notebook_id from pg_temp.citation_fixture), (select source_x from pg_temp.citation_fixture),
    pg_temp.vector_literal(21, 0.01)
  ),
  'citation fixture: owner creates chunk X'
);
update pg_temp.citation_fixture
set chunk_x = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
select pg_temp.setup_insert(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'source Y') $f$,
    (select source_y from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: owner creates source Y'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'chunk Y', %L::extensions.vector) returning id $f$,
    (select notebook_id from pg_temp.citation_fixture), (select source_y from pg_temp.citation_fixture),
    pg_temp.vector_literal(22, 0.01)
  ),
  'citation fixture: owner creates chunk Y'
);
update pg_temp.citation_fixture
set chunk_y = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;

select pg_temp.act_lives(
  (select viewer_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'user', 'What does the document say?') $f$,
    (select message_question from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: the viewer asks a question'
);
-- A citation on the *question* itself (role='user'), not just the answer:
-- the chunk_id FK's ON DELETE SET NULL action and clear_citation_quote apply
-- to every citation row regardless of its message's role, but
-- private.redact_cited_answers() only overwrites content `where role =
-- 'assistant'`. Without this fixture row, that filter is untested -- a bug
-- that dropped the role condition would only be caught by accident (via the
-- message_answer case, which cannot distinguish "redacted because it is an
-- assistant message" from "redacted because it merely had a nulled
-- citation").
select pg_temp.act_lives(
  (select viewer_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'quote from X in the question') $f$,
    (select message_question from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture),
    (select chunk_x from pg_temp.citation_fixture)
  ),
  'citation fixture: the viewer''s own question also cites chunk X'
);
select pg_temp.act_lives(
  (select viewer_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'According to the sources...') $f$,
    (select message_answer from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: the viewer''s question gets an answer'
);
select pg_temp.act_lives(
  (select viewer_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'quote from X') $f$,
    (select message_answer from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture),
    (select chunk_x from pg_temp.citation_fixture)
  ),
  'citation fixture: the answer cites chunk X'
);
select pg_temp.act_lives(
  (select viewer_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 2, %L, 'quote from Y') $f$,
    (select message_answer from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture),
    (select chunk_y from pg_temp.citation_fixture)
  ),
  'citation fixture: the answer also cites chunk Y'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'owner''s own answer, cites Y only') $f$,
    (select message_owner_answer from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture)
  ),
  'citation fixture: a different member (the owner) has their own answer'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.citation_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'owner''s quote from Y') $f$,
    (select message_owner_answer from pg_temp.citation_fixture), (select notebook_id from pg_temp.citation_fixture),
    (select chunk_y from pg_temp.citation_fixture)
  ),
  'citation fixture: the owner''s own answer cites chunk Y only'
);

-- ---------------------------------------------------------------------------
-- 7e) Behavioural: fail-safe when the quote-clearing trigger is disabled
-- ---------------------------------------------------------------------------
--
-- private.clear_citation_quote() is what normally keeps quote in lockstep
-- with chunk_id when the chunk_id FK's ON DELETE SET NULL action fires. With
-- it disabled, that action would leave chunk_id null but quote still set --
-- exactly the state (chunk_id is null) = (quote is null) forbids -- so the
-- CHECK constraint itself must still stop the delete (23514), as a safety
-- net independent of the trigger. Re-enabled immediately after so every
-- later test in this file still gets the real, intended behaviour.
--
-- Named trigger only, not `disable trigger all`: ALL also reaches the table's
-- internal RI (foreign-key) system triggers, and disabling those requires
-- actual superuser -- the `postgres` role this file runs as is not one
-- (confirmed the hard way: "permission denied: RI_ConstraintTrigger_... is a
-- system trigger"). Disabling only the named BEFORE UPDATE OF chunk_id
-- trigger needs no special privilege beyond being the table owner and is
-- exactly the scenario the fail-safe is about anyway.
select pg_temp.sql_lives(
  'alter table public.message_citations disable trigger message_citations_clear_quote',
  'disabling message_citations_clear_quote (fail-safe test setup) succeeds'
);
select pg_temp.act_throws(
  (select owner_id from pg_temp.citation_fixture),
  format('delete from public.sources where id = %L', (select source_failsafe from pg_temp.citation_fixture)),
  '23514',
  'with the quote-clearing trigger disabled, deleting a cited chunk''s source raises 23514 (the CHECK is a real fail-safe)'
);
select pg_temp.sql_lives(
  'alter table public.message_citations enable trigger message_citations_clear_quote',
  're-enabling message_citations_clear_quote succeeds'
);

-- ---------------------------------------------------------------------------
-- 7f) Behavioural: cross-user redaction (the human's explicit requirement)
-- ---------------------------------------------------------------------------
--
-- The editor -- not the viewer who owns the question/answer/citations --
-- deletes source X. private.redact_cited_answers() fires inside the FK's ON
-- DELETE SET NULL action as the editor (current_user = authenticated, sub =
-- editor_id); if it were SECURITY INVOKER, an RLS-respecting UPDATE of the
-- viewer's own message would match 0 rows and silently do nothing. The
-- assertions below read back the actual stored values (privileged, bypassing
-- RLS, since this file runs as postgres) to prove the content really
-- changed -- not just that the DELETE itself returned success.
select pg_temp.act_lives(
  (select editor_id from pg_temp.citation_fixture),
  format('delete from public.sources where id = %L', (select source_x from pg_temp.citation_fixture)),
  'an editor (not the viewer who owns the citation) deletes source X'
);

select pg_temp.safe_ok(
  format(
    $f$ select chunk_id is null and quote is null
        from public.message_citations where message_id = %L and ordinal = 1 $f$,
    (select message_answer from pg_temp.citation_fixture)
  ),
  'the citation to the deleted chunk X now has chunk_id and quote both null'
);
select pg_temp.safe_ok(
  format(
    $f$ select content = 'Antwort entfernt, Quelle gelöscht'
        from public.messages where id = %L $f$,
    (select message_answer from pg_temp.citation_fixture)
  ),
  'the assistant message''s content is redacted to exactly ''Antwort entfernt, Quelle gelöscht'''
);
select pg_temp.safe_ok(
  format(
    $f$ select content = 'What does the document say?'
        from public.messages where id = %L $f$,
    (select message_question from pg_temp.citation_fixture)
  ),
  'the viewer''s user question is unchanged'
);
-- The role filter in private.redact_cited_answers(): the citation on the
-- *question* (role='user') pointing at the same deleted chunk X must still
-- be nulled by the chunk_id FK/clear_citation_quote (those apply regardless
-- of role) -- but, per the assertion right above, the question's own content
-- must NOT be overwritten, proving `where role = 'assistant'` actually does
-- something.
select pg_temp.safe_ok(
  format(
    $f$ select chunk_id is null and quote is null
        from public.message_citations where message_id = %L and ordinal = 1 $f$,
    (select message_question from pg_temp.citation_fixture)
  ),
  'the question''s own citation to the deleted chunk X is also nulled, even though its content is untouched'
);
select pg_temp.safe_ok(
  format(
    $f$ select chunk_id = %L and quote = 'quote from Y'
        from public.message_citations where message_id = %L and ordinal = 2 $f$,
    (select chunk_y from pg_temp.citation_fixture), (select message_answer from pg_temp.citation_fixture)
  ),
  'the citation to chunk Y is unchanged'
);
select pg_temp.safe_ok(
  format(
    $f$ select content = 'owner''s own answer, cites Y only'
        from public.messages where id = %L $f$,
    (select message_owner_answer from pg_temp.citation_fixture)
  ),
  'another member''s own answer citing only Y is unchanged'
);
select pg_temp.safe_ok(
  format(
    $f$ select chunk_id = %L and quote = 'owner''s quote from Y'
        from public.message_citations where message_id = %L and ordinal = 1 $f$,
    (select chunk_y from pg_temp.citation_fixture), (select message_owner_answer from pg_temp.citation_fixture)
  ),
  'the other member''s citation to chunk Y is unchanged'
);

-- ---------------------------------------------------------------------------
-- 7g) Behavioural: deleting a user account with cited answers present
-- ---------------------------------------------------------------------------
--
-- messages.user_id references auth.users ON DELETE CASCADE and
-- sources.created_by references auth.users ON DELETE SET NULL (PR 3/A1's own
-- schema) -- deleting a user's auth.users row (as postgres, modelling
-- Supabase Auth's own account-deletion path, never done through RLS) must
-- cascade their messages (and, through messages' own id/notebook_id FK,
-- their message_citations) away, while merely detaching their sources rather
-- than deleting them. The deleted member is an editor, not an owner, so
-- guard_last_owner (see 010_notebooks_memberships.test.sql) never enters the
-- picture here.
create table pg_temp.account_deletion_fixture (
  owner_id uuid not null,
  editor_id uuid not null,
  notebook_id uuid not null,
  source_editor uuid not null,
  chunk_editor uuid,
  message_editor uuid not null,
  source_owner uuid not null,
  chunk_owner uuid,
  message_owner uuid not null
);
insert into pg_temp.account_deletion_fixture (
  owner_id, editor_id, notebook_id, source_editor, message_editor, source_owner, message_owner
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid()
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (select unnest(array[owner_id, editor_id]) as u from pg_temp.account_deletion_fixture) as users;

select pg_temp.act_lives(
  (select owner_id from pg_temp.account_deletion_fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_id from pg_temp.account_deletion_fixture), 'account deletion notebook'),
  'account-deletion fixture: owner creates the notebook'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.account_deletion_fixture),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_id from pg_temp.account_deletion_fixture), (select editor_id from pg_temp.account_deletion_fixture), 'editor'),
  'account-deletion fixture: owner adds the editor'
);

select pg_temp.setup_insert(
  (select editor_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'editor source') $f$,
    (select source_editor from pg_temp.account_deletion_fixture), (select notebook_id from pg_temp.account_deletion_fixture)
  ),
  'account-deletion fixture: the editor creates their own source'
);
select pg_temp.act_insert_id(
  (select editor_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'editor chunk', %L::extensions.vector) returning id $f$,
    (select notebook_id from pg_temp.account_deletion_fixture), (select source_editor from pg_temp.account_deletion_fixture),
    pg_temp.vector_literal(30, 0.01)
  ),
  'account-deletion fixture: the editor creates a chunk'
);
update pg_temp.account_deletion_fixture
set chunk_editor = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
select pg_temp.act_lives(
  (select editor_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'editor''s cited answer') $f$,
    (select message_editor from pg_temp.account_deletion_fixture), (select notebook_id from pg_temp.account_deletion_fixture)
  ),
  'account-deletion fixture: the editor has an assistant answer'
);
select pg_temp.act_lives(
  (select editor_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'editor quote') $f$,
    (select message_editor from pg_temp.account_deletion_fixture), (select notebook_id from pg_temp.account_deletion_fixture),
    (select chunk_editor from pg_temp.account_deletion_fixture)
  ),
  'account-deletion fixture: the editor''s answer cites their own chunk'
);

select pg_temp.setup_insert(
  (select owner_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'owner source') $f$,
    (select source_owner from pg_temp.account_deletion_fixture), (select notebook_id from pg_temp.account_deletion_fixture)
  ),
  'account-deletion fixture: the owner creates their own source (control)'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'owner chunk', %L::extensions.vector) returning id $f$,
    (select notebook_id from pg_temp.account_deletion_fixture), (select source_owner from pg_temp.account_deletion_fixture),
    pg_temp.vector_literal(31, 0.01)
  ),
  'account-deletion fixture: the owner creates a chunk'
);
update pg_temp.account_deletion_fixture
set chunk_owner = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
select pg_temp.act_lives(
  (select owner_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'owner''s cited answer (control)') $f$,
    (select message_owner from pg_temp.account_deletion_fixture), (select notebook_id from pg_temp.account_deletion_fixture)
  ),
  'account-deletion fixture: the owner has an assistant answer (control)'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.account_deletion_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'owner quote') $f$,
    (select message_owner from pg_temp.account_deletion_fixture), (select notebook_id from pg_temp.account_deletion_fixture),
    (select chunk_owner from pg_temp.account_deletion_fixture)
  ),
  'account-deletion fixture: the owner''s answer cites their own chunk (control)'
);

-- Non-vacuous: the editor's message and citation really exist before the
-- account is deleted.
select pg_temp.safe_ok(
  format('select (select count(*) from public.messages where id = %L) = 1', (select message_editor from pg_temp.account_deletion_fixture)),
  'the editor''s message exists before their account is deleted'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.message_citations where message_id = %L) = 1', (select message_editor from pg_temp.account_deletion_fixture)),
  'the editor''s citation exists before their account is deleted'
);

select pg_temp.sql_lives(
  format('delete from auth.users where id = %L', (select editor_id from pg_temp.account_deletion_fixture)),
  'deleting the editor''s auth.users row (account deletion) succeeds'
);

select pg_temp.safe_ok(
  format('select (select count(*) from public.messages where user_id = %L) = 0', (select editor_id from pg_temp.account_deletion_fixture)),
  'the deleted editor''s messages are gone'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.message_citations where message_id = %L) = 0', (select message_editor from pg_temp.account_deletion_fixture)),
  'the deleted editor''s citations are gone'
);
select pg_temp.safe_ok(
  format(
    $f$ select exists (select 1 from public.sources where id = %L) and created_by is null
        from public.sources where id = %L $f$,
    (select source_editor from pg_temp.account_deletion_fixture), (select source_editor from pg_temp.account_deletion_fixture)
  ),
  'the deleted editor''s source still exists, with created_by set to null'
);
select pg_temp.safe_ok(
  format(
    $f$ select content = 'owner''s cited answer (control)'
        from public.messages where id = %L $f$,
    (select message_owner from pg_temp.account_deletion_fixture)
  ),
  'another member''s (the owner''s) message is unaffected'
);
select pg_temp.safe_ok(
  format(
    $f$ select chunk_id = %L and quote = 'owner quote'
        from public.message_citations where message_id = %L and ordinal = 1 $f$,
    (select chunk_owner from pg_temp.account_deletion_fixture), (select message_owner from pg_temp.account_deletion_fixture)
  ),
  'another member''s (the owner''s) citation is unaffected'
);

-- ---------------------------------------------------------------------------
-- 7h) Behavioural: deleting a source and a member's account in the same
-- transaction (PR #19, item 2b2)
-- ---------------------------------------------------------------------------
--
-- Two separate DELETE statements, same transaction (this whole file already
-- is one): the owner deletes their own source (whose chunk the member's
-- answer cites, so this nulls the member's citation first), then the
-- member's account is deleted outright (cascading their messages/citations
-- away entirely). Asserts both succeed and leave the expected end state,
-- without the first delete's cascade leaving anything in a state the second
-- delete's cascade cannot cleanly finish from.
create table pg_temp.combined_deletion_fixture (
  owner_id uuid not null,
  member_id uuid not null,
  notebook_id uuid not null,
  source_id uuid not null,
  chunk_id uuid,
  message_id uuid not null
);
insert into pg_temp.combined_deletion_fixture (owner_id, member_id, notebook_id, source_id, message_id)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
select u, u::text || '@example.test', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
from (select unnest(array[owner_id, member_id]) as u from pg_temp.combined_deletion_fixture) as users;

select pg_temp.act_lives(
  (select owner_id from pg_temp.combined_deletion_fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_id from pg_temp.combined_deletion_fixture), 'combined deletion notebook'),
  'combined-deletion fixture: owner creates the notebook'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.combined_deletion_fixture),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_id from pg_temp.combined_deletion_fixture), (select member_id from pg_temp.combined_deletion_fixture), 'editor'),
  'combined-deletion fixture: owner adds the member'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.combined_deletion_fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'owner source') $f$,
    (select source_id from pg_temp.combined_deletion_fixture), (select notebook_id from pg_temp.combined_deletion_fixture)
  ),
  'combined-deletion fixture: owner creates a source'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.combined_deletion_fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'owner chunk', %L::extensions.vector) returning id $f$,
    (select notebook_id from pg_temp.combined_deletion_fixture), (select source_id from pg_temp.combined_deletion_fixture),
    pg_temp.vector_literal(40, 0.01)
  ),
  'combined-deletion fixture: owner creates a chunk'
);
update pg_temp.combined_deletion_fixture
set chunk_id = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
select pg_temp.act_lives(
  (select member_id from pg_temp.combined_deletion_fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'member''s answer, cites the owner''s chunk') $f$,
    (select message_id from pg_temp.combined_deletion_fixture), (select notebook_id from pg_temp.combined_deletion_fixture)
  ),
  'combined-deletion fixture: the member has an assistant answer'
);
select pg_temp.act_lives(
  (select member_id from pg_temp.combined_deletion_fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'member quote') $f$,
    (select message_id from pg_temp.combined_deletion_fixture), (select notebook_id from pg_temp.combined_deletion_fixture),
    (select chunk_id from pg_temp.combined_deletion_fixture)
  ),
  'combined-deletion fixture: the member''s answer cites the owner''s chunk'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.combined_deletion_fixture),
  format('delete from public.sources where id = %L', (select source_id from pg_temp.combined_deletion_fixture)),
  'combined deletion: the owner deletes their source'
);
select pg_temp.sql_lives(
  format('delete from auth.users where id = %L', (select member_id from pg_temp.combined_deletion_fixture)),
  'combined deletion: the member''s account is then deleted in the same transaction'
);

select pg_temp.safe_ok(
  format('select (select count(*) from public.messages where user_id = %L) = 0', (select member_id from pg_temp.combined_deletion_fixture)),
  'combined deletion: the member''s messages are gone'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.message_citations where message_id = %L) = 0', (select message_id from pg_temp.combined_deletion_fixture)),
  'combined deletion: the member''s citation is gone'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.chunks where notebook_id = %L) = 0', (select notebook_id from pg_temp.combined_deletion_fixture)),
  'combined deletion: the owner''s chunk is gone with its source'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.notebooks where id = %L) = 1', (select notebook_id from pg_temp.combined_deletion_fixture)),
  'combined deletion: the notebook itself is untouched'
);

-- ---------------------------------------------------------------------------
-- 8) Behavioural: cascades
-- ---------------------------------------------------------------------------

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_cascade from pg_temp.fixture), 'cascade notebook'),
  'cascade fixture: owner creates the notebook that will be deleted'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_cascade_keep from pg_temp.fixture), 'cascade keep notebook'),
  'cascade fixture: owner creates a sibling notebook that is left untouched'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'to be cascaded') $f$,
    (select source_cascade from pg_temp.fixture), (select notebook_cascade from pg_temp.fixture)
  ),
  'cascade fixture: a source in the notebook that will be deleted'
);
select pg_temp.act_insert_id(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'to be cascaded', %L::extensions.vector) returning id $f$,
    (select notebook_cascade from pg_temp.fixture), (select source_cascade from pg_temp.fixture),
    pg_temp.vector_literal(3, 0.01)
  ),
  'cascade fixture: a chunk in the notebook that will be deleted'
);
update pg_temp.fixture
set chunk_cascade = nullif(current_setting('pgtap_fixture.last_inserted_id', true), '')::uuid;
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'to be cascaded') $f$,
    (select message_cascade from pg_temp.fixture), (select notebook_cascade from pg_temp.fixture)
  ),
  'cascade fixture: a message in the notebook that will be deleted'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'to be cascaded') $f$,
    (select message_cascade from pg_temp.fixture), (select notebook_cascade from pg_temp.fixture),
    (select chunk_cascade from pg_temp.fixture)
  ),
  'cascade fixture: a citation in the notebook that will be deleted'
);

-- PR #19, item 2: a second member with their own cited assistant answer,
-- citing the *same* chunk as the first message. A single `delete from
-- notebooks` below then has to process, within one statement: the
-- chunk_id FK's ON DELETE SET NULL action against *both* citation rows
-- (one chunk, two citing messages) at the same time the messages' own
-- notebook_id FK (ON DELETE CASCADE) is deleting the messages -- and, through
-- message_citations' own (message_id, notebook_id) FK, deleting the citation
-- rows outright. A citation row hit by both paths in the same command is
-- exactly the shape that can raise "tuple to be updated was already modified
-- by an operation triggered by the current command" if the two FK actions
-- are not independent operations Postgres can interleave safely.
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebook_members (notebook_id, user_id, role) values (%L, %L, %L)',
    (select notebook_cascade from pg_temp.fixture), (select editor_cascade_id from pg_temp.fixture), 'editor'),
  'cascade fixture: owner adds a second member to the notebook that will be deleted'
);
select pg_temp.act_lives(
  (select editor_cascade_id from pg_temp.fixture),
  format(
    $f$ insert into public.messages (id, notebook_id, role, content) values (%L, %L, 'assistant', 'second member''s answer, to be cascaded') $f$,
    (select message_cascade_2 from pg_temp.fixture), (select notebook_cascade from pg_temp.fixture)
  ),
  'cascade fixture: a second member''s message in the notebook that will be deleted'
);
select pg_temp.act_lives(
  (select editor_cascade_id from pg_temp.fixture),
  format(
    $f$ insert into public.message_citations (message_id, notebook_id, ordinal, chunk_id, quote) values (%L, %L, 1, %L, 'second member''s quote') $f$,
    (select message_cascade_2 from pg_temp.fixture), (select notebook_cascade from pg_temp.fixture),
    (select chunk_cascade from pg_temp.fixture)
  ),
  'cascade fixture: the second member''s answer cites the same chunk'
);

select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'kept source') $f$,
    gen_random_uuid(), (select notebook_cascade_keep from pg_temp.fixture)
  ),
  'cascade fixture: a source in the untouched sibling notebook'
);

-- Non-vacuous: the chunk, both messages and both citations really exist
-- before the delete, so "0 after" below actually proves a cascade happened
-- instead of nothing having been there in the first place.
select pg_temp.safe_ok(
  format('select (select count(*) from public.chunks where notebook_id = %L) = 1', (select notebook_cascade from pg_temp.fixture)),
  'the chunk exists in notebook_cascade before it is deleted'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.messages where notebook_id = %L) = 2', (select notebook_cascade from pg_temp.fixture)),
  'both members'' messages exist in notebook_cascade before it is deleted'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.message_citations where notebook_id = %L) = 2', (select notebook_cascade from pg_temp.fixture)),
  'both citations (from two different users, to the same chunk) exist before the notebook is deleted'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('delete from public.notebooks where id = %L', (select notebook_cascade from pg_temp.fixture)),
  'the owner deletes notebook_cascade'
);

select pg_temp.safe_ok(
  format('select (select count(*) from public.sources where notebook_id = %L) = 0', (select notebook_cascade from pg_temp.fixture)),
  'no sources remain for the deleted notebook'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.chunks where notebook_id = %L) = 0', (select notebook_cascade from pg_temp.fixture)),
  'no chunks remain for the deleted notebook'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.message_citations where notebook_id = %L) = 0', (select notebook_cascade from pg_temp.fixture)),
  'no citations remain for the deleted notebook'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.messages where notebook_id = %L) = 0', (select notebook_cascade from pg_temp.fixture)),
  'no messages remain for the deleted notebook'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.sources where notebook_id = %L) = 1', (select notebook_cascade_keep from pg_temp.fixture)),
  'the untouched sibling notebook''s source is unaffected (positive control)'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_source_cascade from pg_temp.fixture), 'source cascade notebook'),
  'source-cascade fixture: owner creates a notebook'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title) values (%L, %L, 'text', 'doomed source') $f$,
    (select source_doomed from pg_temp.fixture), (select notebook_source_cascade from pg_temp.fixture)
  ),
  'source-cascade fixture: a source'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        values (%L, %L, 0, 'doomed chunk', %L::extensions.vector) $f$,
    (select notebook_source_cascade from pg_temp.fixture), (select source_doomed from pg_temp.fixture),
    pg_temp.vector_literal(2, 0.01)
  ),
  'source-cascade fixture: a chunk belonging to the doomed source'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('delete from public.sources where id = %L', (select source_doomed from pg_temp.fixture)),
  'the owner deletes the source'
);
select pg_temp.safe_ok(
  format('select (select count(*) from public.chunks where notebook_id = %L) = 0', (select notebook_source_cascade from pg_temp.fixture)),
  'no chunks remain for the deleted source'
);

-- ---------------------------------------------------------------------------
-- 9) match_chunks: access, clamp, and post-filter recall
-- ---------------------------------------------------------------------------

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_match_access from pg_temp.fixture), 'match access notebook'),
  'match_chunks fixture: owner creates the access-test notebook'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'match access source', 'ready') $f$,
    (select source_match_access from pg_temp.fixture), (select notebook_match_access from pg_temp.fixture)
  ),
  'match_chunks fixture: owner creates a source in the access-test notebook'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'chunk ' || gs, pg_temp.vector_literal(gs + 1, 0.01)::extensions.vector
        from generate_series(0, 4) as gs $f$,
    (select notebook_match_access from pg_temp.fixture), (select source_match_access from pg_temp.fixture)
  ),
  'match_chunks fixture: owner inserts 5 chunks into the access-test notebook'
);

select ok(
  (select r !~ '^ERROR:' and r::int > 0
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8)',
       pg_temp.vector_literal(0, 0), (select notebook_match_access from pg_temp.fixture)
     )
   ) as r) s),
  'match_chunks returns results to a member'
);
select ok(
  (select r = '0'
   from (select pg_temp.act_scalar(
     (select stranger_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8)',
       pg_temp.vector_literal(0, 0), (select notebook_match_access from pg_temp.fixture)
     )
   ) as r) s),
  'match_chunks returns 0 rows to a stranger calling with the same notebook id'
);
select ok(
  (select r = 'ERROR:42501'
   from (select pg_temp.anon_scalar(
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8)',
       pg_temp.vector_literal(0, 0), (select notebook_match_access from pg_temp.fixture)
     )
   ) as r) s),
  'anon cannot call match_chunks (42501)'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_match_clamp from pg_temp.fixture), 'match clamp notebook'),
  'match_chunks clamp fixture: owner creates the clamp-test notebook'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'match clamp source', 'ready') $f$,
    (select source_match_clamp from pg_temp.fixture), (select notebook_match_clamp from pg_temp.fixture)
  ),
  'match_chunks clamp fixture: owner creates a source'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'chunk ' || gs, pg_temp.vector_literal(gs + 1, 0.01)::extensions.vector
        from generate_series(0, 59) as gs $f$,
    (select notebook_match_clamp from pg_temp.fixture), (select source_match_clamp from pg_temp.fixture)
  ),
  'match_chunks clamp fixture: owner inserts 60 chunks'
);

select ok(
  (select r !~ '^ERROR:' and r::int <= 50
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 1000)',
       pg_temp.vector_literal(0, 0), (select notebook_match_clamp from pg_temp.fixture)
     )
   ) as r) s),
  'match_count=1000 is clamped to at most 50 rows'
);
select ok(
  (select r = '1'
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 0)',
       pg_temp.vector_literal(0, 0), (select notebook_match_clamp from pg_temp.fixture)
     )
   ) as r) s),
  'match_count=0 is clamped up to exactly 1 row'
);

-- Post-filter recall: a foreign notebook with 300 chunks deceptively close to
-- the query vector (tiny noise), the caller's own notebook with only 5 chunks
-- genuinely relevant but farther away (larger noise). match_chunks does an
-- exact search within `where notebook_id = p_notebook_id` (no approximate
-- index, no planner GUCs to force -- see this file's header), so what this
-- actually pins is that the notebook_id filter restricts the candidate set
-- before the distance ordering and LIMIT, not that it merely filters a
-- global top-K after the fact (which could lose every one of the caller's
-- own, relevant rows to a foreign notebook with enough closer ones).
select pg_temp.act_lives(
  (select foreign_owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_match_recall_foreign from pg_temp.fixture), 'match recall foreign notebook'),
  'recall fixture: a different owner creates the foreign notebook'
);
select pg_temp.setup_insert(
  (select foreign_owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'foreign source', 'ready') $f$,
    (select source_recall_foreign from pg_temp.fixture), (select notebook_match_recall_foreign from pg_temp.fixture)
  ),
  'recall fixture: the foreign owner creates a source'
);

select pg_temp.act_lives(
  (select foreign_owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'foreign chunk ' || gs, pg_temp.vector_literal(gs + 1, 0.0005)::extensions.vector
        from generate_series(0, 299) as gs $f$,
    (select notebook_match_recall_foreign from pg_temp.fixture), (select source_recall_foreign from pg_temp.fixture)
  ),
  'recall fixture: the foreign owner inserts 300 chunks very close to the query vector'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_match_recall_own from pg_temp.fixture), 'match recall own notebook'),
  'recall fixture: the caller creates their own notebook'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'own source', 'ready') $f$,
    (select source_recall_own from pg_temp.fixture), (select notebook_match_recall_own from pg_temp.fixture)
  ),
  'recall fixture: the caller creates a source in their own notebook'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'own chunk ' || gs, pg_temp.vector_literal(gs + 1, 0.05)::extensions.vector
        from generate_series(0, 4) as gs $f$,
    (select notebook_match_recall_own from pg_temp.fixture), (select source_recall_own from pg_temp.fixture)
  ),
  'recall fixture: the caller inserts their own 5, farther-away but relevant chunks'
);

select ok(
  (select r = '5'
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8)',
       pg_temp.vector_literal(0, 0), (select notebook_match_recall_own from pg_temp.fixture)
     )
   ) as r) s),
  'match_chunks returns all 5 of the caller''s own chunks despite 300 closer foreign candidates'
);

-- Exactness, not just "all of a small set came back": 60 own chunks, every
-- one a distinct, known distance from the query vector (one fixed seed, so
-- cosine distance to the all-zero-noise query vector is strictly monotonic
-- in `noise` alone -- see this file's header for why a fixed seed matters
-- here but not for the "5 vs 300" test above). The 8 nearest are exactly
-- ordinals 0..7 by construction. match_chunks's own "id, source_id, ordinal,
-- content, page, similarity" row shape is used here via `ordinal` as a
-- stand-in identity that is easy to assert on without a round trip through
-- public.chunks (see the fixture-id comment above for why this file avoids
-- that); string_agg with no ORDER BY preserves match_chunks's own emission
-- order, so this also pins the function returning its rows pre-sorted by
-- distance, not merely containing the right set.
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_match_exact from pg_temp.fixture), 'match exact notebook'),
  'exact-top-8 fixture: owner creates the notebook'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'match exact source', 'ready') $f$,
    (select source_match_exact from pg_temp.fixture), (select notebook_match_exact from pg_temp.fixture)
  ),
  'exact-top-8 fixture: owner creates a source'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'exact chunk ' || gs, pg_temp.vector_literal(1, (gs + 1) * 0.001)::extensions.vector
        from generate_series(0, 59) as gs $f$,
    (select notebook_match_exact from pg_temp.fixture), (select source_match_exact from pg_temp.fixture)
  ),
  'exact-top-8 fixture: owner inserts 60 chunks with strictly increasing distance from the query vector (ordinal 0 nearest, 59 farthest)'
);

select ok(
  (select r = '0,1,2,3,4,5,6,7'
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       $f$ select coalesce(string_agg(ordinal::text, ','), '') from public.match_chunks(%L::extensions.vector, %L, 8) $f$,
       pg_temp.vector_literal(0, 0), (select notebook_match_exact from pg_temp.fixture)
     )
   ) as r) s),
  'match_chunks returns exactly the 8 nearest of 60 own chunks, in distance order (ordinals 0..7)'
);

-- Only chunks of ready sources are searched. One notebook with a ready source
-- (5 chunks, farther away) next to a pending, a processing and a failed source
-- (3 chunks each, much closer to the query vector). With match_count 8 an
-- unfiltered search would return the 9 closer non-ready chunks first (capped
-- at 8) and the ready source would lose rows; the filtered search returns the
-- ready source's 5 rows and nothing from the others.
create table pg_temp.status_fixture (
  notebook_id uuid not null default gen_random_uuid(),
  source_ready uuid not null default gen_random_uuid(),
  source_pending uuid not null default gen_random_uuid(),
  source_processing uuid not null default gen_random_uuid(),
  source_failed uuid not null default gen_random_uuid()
);
insert into pg_temp.status_fixture default values;

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format('insert into public.notebooks (id, title) values (%L, %L)', (select notebook_id from pg_temp.status_fixture), 'match status notebook'),
  'ready-only fixture: owner creates the notebook'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'ready source', 'ready') $f$,
    (select source_ready from pg_temp.status_fixture), (select notebook_id from pg_temp.status_fixture)
  ),
  'ready-only fixture: a ready source'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'pending source', 'pending') $f$,
    (select source_pending from pg_temp.status_fixture), (select notebook_id from pg_temp.status_fixture)
  ),
  'ready-only fixture: a pending source'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status) values (%L, %L, 'text', 'processing source', 'processing') $f$,
    (select source_processing from pg_temp.status_fixture), (select notebook_id from pg_temp.status_fixture)
  ),
  'ready-only fixture: a processing source'
);
select pg_temp.setup_insert(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.sources (id, notebook_id, kind, title, status, error_category) values (%L, %L, 'text', 'failed source', 'failed', 'extract_failed') $f$,
    (select source_failed from pg_temp.status_fixture), (select notebook_id from pg_temp.status_fixture)
  ),
  'ready-only fixture: a failed source'
);

select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'ready chunk ' || gs, pg_temp.vector_literal(gs + 1, 0.05)::extensions.vector
        from generate_series(0, 4) as gs $f$,
    (select notebook_id from pg_temp.status_fixture), (select source_ready from pg_temp.status_fixture)
  ),
  'ready-only fixture: 5 chunks for the ready source'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'pending chunk ' || gs, pg_temp.vector_literal(gs + 11, 0.0005)::extensions.vector
        from generate_series(0, 2) as gs $f$,
    (select notebook_id from pg_temp.status_fixture), (select source_pending from pg_temp.status_fixture)
  ),
  'ready-only fixture: 3 closer chunks for the pending source'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'processing chunk ' || gs, pg_temp.vector_literal(gs + 21, 0.0005)::extensions.vector
        from generate_series(0, 2) as gs $f$,
    (select notebook_id from pg_temp.status_fixture), (select source_processing from pg_temp.status_fixture)
  ),
  'ready-only fixture: 3 closer chunks for the processing source'
);
select pg_temp.act_lives(
  (select owner_id from pg_temp.fixture),
  format(
    $f$ insert into public.chunks (notebook_id, source_id, ordinal, content, embedding)
        select %L, %L, gs, 'failed chunk ' || gs, pg_temp.vector_literal(gs + 31, 0.0005)::extensions.vector
        from generate_series(0, 2) as gs $f$,
    (select notebook_id from pg_temp.status_fixture), (select source_failed from pg_temp.status_fixture)
  ),
  'ready-only fixture: 3 closer chunks for the failed source'
);

select ok(
  (select r = '5'
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8)',
       pg_temp.vector_literal(0, 0), (select notebook_id from pg_temp.status_fixture)
     )
   ) as r) s),
  'match_chunks returns 5 rows (the ready source''s) from a notebook that also holds 9 closer non-ready chunks'
);
select ok(
  (select r = '5'
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8) where source_id = %L',
       pg_temp.vector_literal(0, 0), (select notebook_id from pg_temp.status_fixture),
       (select source_ready from pg_temp.status_fixture)
     )
   ) as r) s),
  'the ready source keeps all 5 of its rows in the top-k'
);
select ok(
  (select r = '0'
   from (select pg_temp.act_scalar(
     (select owner_id from pg_temp.fixture),
     format(
       'select count(*)::text from public.match_chunks(%L::extensions.vector, %L, 8) where source_id = any (%L::uuid[])',
       pg_temp.vector_literal(0, 0), (select notebook_id from pg_temp.status_fixture),
       (select array[source_pending, source_processing, source_failed]::text from pg_temp.status_fixture)
     )
   ) as r) s),
  'pending, processing and failed sources contribute no rows to match_chunks'
);

select * from finish();

rollback;
