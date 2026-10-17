-- Catalog guardrails that every later migration must keep satisfying.
--
-- Each check is defined once as a `pg_temp` function returning one identifier
-- per violation, so it can be (1) asserted empty against the real catalog and
-- (2) proven to actually bite with a negative self-test: a `catalog_probe_`
-- object that the check must flag by its exact identifier.
--
-- Self-test probes are created directly (no SAVEPOINT) and are cleaned up
-- only by the final ROLLBACK, because pgTAP records each assertion's result
-- in a temp table as part of the surrounding transaction: rolling back to a
-- SAVEPOINT taken before an assertion discards that bookkeeping along with
-- the probe, which desyncs `plan()` from what pg_prove actually sees (shows
-- up as "Looks like you planned N tests but ran M" and can hide a later
-- failure). Because probes accumulate for the rest of the file, every
-- self-test's query filters the check's output down to rows containing that
-- probe's own unique `catalog_probe_<name>` substring, so an earlier probe
-- (e.g. a table with RLS disabled, which also has no policies) can never
-- leak into a later check's self-test (e.g. "every table has policies") and
-- corrupt its expected result.
--
-- pgTAP lives in: `select extnamespace::regnamespace from pg_extension where
-- extname = 'pgtap'`. Locally the Supabase CLI installs it into `extensions`,
-- not `public` or `private`, so it never reaches the `nspname in
-- ('public','private')` scope of checks 4-6 in the first place. Even if a
-- future environment installed it into `public`, every pgTAP function is
-- owned by the `pgtap` extension (`pg_depend.deptype = 'e'`), which checks
-- 4-6 explicitly exclude below -- so the exclusion covers that case too.
--
-- SECURITY DEFINER allowlist (check security_definer_allowlist):
--   * non-trigger functions: `private.notebook_role(uuid)` only (see its ADR).
--   * trigger functions: none yet. PR 3 adds the membership audit/guard
--     triggers it introduces here, by exact schema-qualified signature
--     (e.g. 'public.some_trigger()'), once they exist.

begin;

select plan(20);

-- ---------------------------------------------------------------------------
-- Check definitions
-- ---------------------------------------------------------------------------

-- 1. rls_disabled: every ordinary/partitioned table in public has RLS on.
-- Partitions are excluded: RLS is governed by the partitioned (root) table.
create function pg_temp.check_rls_disabled() returns setof text as $$
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relispartition
    and c.relrowsecurity = false;
$$ language sql;

-- 2. missing_policies: every public table has >=1 policy for each of
-- select/insert/update/delete. A `for all` policy (polcmd = '*') counts for
-- every command; check 3 separately forbids `for all` policies from existing
-- at all, so in practice a table must have four distinct policies.
create function pg_temp.check_missing_policies() returns setof text as $$
  with tables as (
    select c.oid, n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relispartition
  ),
  cmds(code, label) as (
    values ('r', 'select'), ('a', 'insert'), ('w', 'update'), ('d', 'delete')
  )
  select t.nspname || '.' || t.relname || ':' || cmds.label
  from tables t
  cross join cmds
  where not exists (
    select 1
    from pg_policy p
    where p.polrelid = t.oid
      and p.polcmd in (cmds.code, '*')
  );
$$ language sql;

-- 3. for_all_policies: no policy anywhere in public is `for all`.
create function pg_temp.check_for_all_policies() returns setof text as $$
  select n.nspname || '.' || c.relname || ':' || p.polname
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polcmd = '*';
$$ language sql;

-- 4. security_definer_allowlist: every SECURITY DEFINER function in public or
-- private (excluding ones owned by an extension) must be on the allowlist
-- documented at the top of this file.
create function pg_temp.check_security_definer_allowlist() returns setof text as $$
  with allowed_nontrigger(sig) as (
    values ('private.notebook_role(uuid)')
  ),
  allowed_trigger(sig) as (
    -- PR 3 adds allowed trigger function signatures here by exact
    -- schema-qualified signature (e.g. 'public.some_trigger()'). Empty today.
    select unnest(array[]::text[])
  ),
  allowed(sig) as (
    select sig from allowed_nontrigger
    union all
    select sig from allowed_trigger
  ),
  candidates as (
    select n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' as sig
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
  where sig not in (select sig from allowed);
$$ language sql;

-- 5. security_definer_returns_trigger: every SECURITY DEFINER function in
-- public or private, other than private.notebook_role(uuid), returns trigger.
create function pg_temp.check_security_definer_returns_trigger() returns setof text as $$
  select sig
  from (
    select n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' as sig,
           p.prorettype
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
      )
  ) f
  where f.sig <> 'private.notebook_role(uuid)'
    and f.prorettype <> 'trigger'::regtype;
$$ language sql;

-- 6. missing_search_path: every function/procedure in public or private
-- (excluding extension members) sets search_path explicitly.
create function pg_temp.check_missing_search_path() returns setof text as $$
  select n.nspname || '.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prokind in ('f', 'p')
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
      where cfg ilike 'search_path=%'
    );
$$ language sql;

-- 7. anon_table_privileges: `anon` has no privilege on any public table,
-- view, matview or sequence, no USAGE on schema private, and no EXECUTE on
-- any function in private. If `private` does not exist yet those parts are
-- simply empty (the join against pg_namespace finds nothing).
create function pg_temp.check_anon_table_privileges() returns setof text as $$
  with rel_acl as (
    select n.nspname, c.relname, c.relkind, c.relowner,
           coalesce(c.relacl,
             acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner)
           ) as acl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'm', 'S')
  ),
  flagged_tables as (
    select distinct nspname || '.' || relname as sig
    from rel_acl, lateral aclexplode(acl) a
    where a.grantee = 'anon'::regrole
      and a.privilege_type in
        ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ),
  schema_usage as (
    select distinct n.nspname as sig
    from pg_namespace n, lateral aclexplode(
      coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))
    ) a
    where n.nspname = 'private'
      and a.grantee = 'anon'::regrole
      and a.privilege_type = 'USAGE'
  ),
  fn_exec as (
    select distinct n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
    lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
    where n.nspname = 'private'
      and a.grantee = 'anon'::regrole
      and a.privilege_type = 'EXECUTE'
  )
  select sig from flagged_tables
  union all
  select sig from schema_usage
  union all
  select sig from fn_exec;
$$ language sql;

-- 8. authenticated_private_privileges: `authenticated` has no table privilege
-- on any relation in schema private.
create function pg_temp.check_authenticated_private_privileges() returns setof text as $$
  select distinct n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace,
  lateral aclexplode(
    coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))
  ) a
  where n.nspname = 'private'
    and c.relkind in ('r', 'v', 'm', 'S')
    and a.grantee = 'authenticated'::regrole;
$$ language sql;

-- 9. views_not_security_invoker: every view in public is security_invoker.
create function pg_temp.check_views_not_security_invoker() returns setof text as $$
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'v'
    and not exists (
      select 1 from unnest(coalesce(c.reloptions, '{}')) opt
      where opt ilike 'security_invoker=true' or opt ilike 'security_invoker=on'
    );
$$ language sql;

-- 10. user_metadata_in_policies: no policy in public reads user_metadata /
-- raw_user_meta_data (roles must come from app_metadata, never client-writable).
create function pg_temp.check_user_metadata_in_policies() returns setof text as $$
  select n.nspname || '.' || c.relname || ':' || p.polname
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~* 'user_metadata|raw_user_meta_data'
      or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'user_metadata|raw_user_meta_data'
    );
$$ language sql;

-- ---------------------------------------------------------------------------
-- 1) Real catalog: every check must be empty. Run first, before any probes
-- exist, so a probe from one check's self-test can never taint another
-- check's "is empty" assertion.
-- ---------------------------------------------------------------------------

select is_empty(
  'select * from pg_temp.check_rls_disabled()',
  'every public table has row level security enabled'
);
select is_empty(
  'select * from pg_temp.check_missing_policies()',
  'every public table has select/insert/update/delete policies'
);
select is_empty(
  'select * from pg_temp.check_for_all_policies()',
  'no public policy uses FOR ALL'
);
select is_empty(
  'select * from pg_temp.check_security_definer_allowlist()',
  'every SECURITY DEFINER function in public/private is on the allowlist'
);
select is_empty(
  'select * from pg_temp.check_security_definer_returns_trigger()',
  'every SECURITY DEFINER function other than private.notebook_role returns trigger'
);
select is_empty(
  'select * from pg_temp.check_missing_search_path()',
  'every function in public/private sets search_path'
);
select is_empty(
  'select * from pg_temp.check_anon_table_privileges()',
  'anon has no table/view/matview/sequence privilege in public and no access to private'
);
select is_empty(
  'select * from pg_temp.check_authenticated_private_privileges()',
  'authenticated has no table privilege on any relation in schema private'
);
select is_empty(
  'select * from pg_temp.check_views_not_security_invoker()',
  'every view in public is security_invoker'
);
select is_empty(
  'select * from pg_temp.check_user_metadata_in_policies()',
  'no public policy reads user_metadata or raw_user_meta_data'
);

-- ---------------------------------------------------------------------------
-- 2) Negative self-tests: prove each check actually bites. Probes are never
-- rolled back mid-file (see header), so every assertion below filters the
-- check's output down to rows containing that probe's own unique
-- `catalog_probe_<name>` substring -- an earlier probe can flag more rows in
-- a later check (e.g. a table created for a different probe also happens to
-- have no RLS-covering policies), but it can never appear in a *filtered*
-- result it doesn't belong to, so the expected array below stays exact.
-- ---------------------------------------------------------------------------

-- check_rls_disabled
create table public.catalog_probe_rls_disabled (id int);
select set_eq(
  $sql$
    select * from pg_temp.check_rls_disabled() as v
    where v like '%catalog_probe_rls_disabled%'
  $sql$,
  array['public.catalog_probe_rls_disabled'],
  'rls_disabled flags a table without row level security enabled'
);

-- check_missing_policies
create table public.catalog_probe_missing_policies (id int);
alter table public.catalog_probe_missing_policies enable row level security;
create policy catalog_probe_missing_policies_select on public.catalog_probe_missing_policies
  for select using (true);
select set_eq(
  $sql$
    select * from pg_temp.check_missing_policies() as v
    where v like '%catalog_probe_missing_policies%'
  $sql$,
  array[
    'public.catalog_probe_missing_policies:insert',
    'public.catalog_probe_missing_policies:update',
    'public.catalog_probe_missing_policies:delete'
  ],
  'missing_policies flags insert/update/delete when only select exists'
);

-- check_for_all_policies
create table public.catalog_probe_for_all (id int);
alter table public.catalog_probe_for_all enable row level security;
create policy catalog_probe_for_all_policy on public.catalog_probe_for_all
  for all using (true);
select set_eq(
  $sql$
    select * from pg_temp.check_for_all_policies() as v
    where v like '%catalog_probe_for_all%'
  $sql$,
  array['public.catalog_probe_for_all:catalog_probe_for_all_policy'],
  'for_all_policies flags a FOR ALL policy'
);

-- check_security_definer_allowlist: a SECURITY DEFINER trigger function that
-- is not on the (currently empty) trigger allowlist is flagged.
create function public.catalog_probe_secdef_trigger() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public as $body$
  begin
    return new;
  end;
$body$;
select set_eq(
  $sql$
    select * from pg_temp.check_security_definer_allowlist() as v
    where v like '%catalog_probe_secdef_trigger%'
  $sql$,
  array['public.catalog_probe_secdef_trigger()'],
  'security_definer_allowlist flags a SECURITY DEFINER trigger function that is not allowlisted'
);

-- check_security_definer_returns_trigger: a SECURITY DEFINER function in
-- private that returns int (not trigger) and is not notebook_role is flagged.
create schema if not exists private;
create function private.catalog_probe_secdef_int() returns int
  language plpgsql security definer set search_path = pg_catalog, private as $body$
  begin
    return 1;
  end;
$body$;
select set_eq(
  $sql$
    select * from pg_temp.check_security_definer_returns_trigger() as v
    where v like '%catalog_probe_secdef_int%'
  $sql$,
  array['private.catalog_probe_secdef_int()'],
  'security_definer_returns_trigger flags a non-trigger SECURITY DEFINER function other than notebook_role'
);

-- check_missing_search_path
create function public.catalog_probe_missing_search_path() returns int
  language sql as $body$ select 1; $body$;
select set_eq(
  $sql$
    select * from pg_temp.check_missing_search_path() as v
    where v like '%catalog_probe_missing_search_path%'
  $sql$,
  array['public.catalog_probe_missing_search_path()'],
  'missing_search_path flags a function without an explicit search_path'
);

-- check_anon_table_privileges: Supabase's default privileges grant anon on
-- new public tables, so merely creating the table is enough to flag it --
-- which is exactly why PR 3 must revoke those defaults.
create table public.catalog_probe_grants (id int);
select set_eq(
  $sql$
    select * from pg_temp.check_anon_table_privileges() as v
    where v like '%catalog_probe_grants%'
  $sql$,
  array['public.catalog_probe_grants'],
  'anon_table_privileges flags a newly created public table with default anon grants'
);

-- check_authenticated_private_privileges
create schema if not exists private;
create table private.catalog_probe_auth_priv (id int);
grant select on private.catalog_probe_auth_priv to authenticated;
select set_eq(
  $sql$
    select * from pg_temp.check_authenticated_private_privileges() as v
    where v like '%catalog_probe_auth_priv%'
  $sql$,
  array['private.catalog_probe_auth_priv'],
  'authenticated_private_privileges flags a private table granted to authenticated'
);

-- check_views_not_security_invoker
create view public.catalog_probe_view as select 1 as id;
select set_eq(
  $sql$
    select * from pg_temp.check_views_not_security_invoker() as v
    where v like '%catalog_probe_view%'
  $sql$,
  array['public.catalog_probe_view'],
  'views_not_security_invoker flags a view without security_invoker'
);

-- check_user_metadata_in_policies
create table public.catalog_probe_metadata_policy (id int);
alter table public.catalog_probe_metadata_policy enable row level security;
create policy catalog_probe_metadata_policy_select on public.catalog_probe_metadata_policy
  for select using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'x');
select set_eq(
  $sql$
    select * from pg_temp.check_user_metadata_in_policies() as v
    where v like '%catalog_probe_metadata_policy%'
  $sql$,
  array['public.catalog_probe_metadata_policy:catalog_probe_metadata_policy_select'],
  'user_metadata_in_policies flags a policy that reads user_metadata'
);

select * from finish();

rollback;
