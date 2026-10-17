-- Catalog guardrails that every later migration must keep satisfying.
--
-- Each check is defined once as a `pg_temp` function returning one identifier
-- per violation, so it can be (1) asserted empty against the real catalog and
-- (2) proven to actually bite with a negative self-test: a `catalog_probe_`
-- object that the check must flag by its exact identifier. Checks 4, 5, 11,
-- 12 and 13 (the ones that exempt `private.notebook_role(uuid)`) also get a
-- POSITIVE self-test: a realistically-shaped probe that those checks must
-- NOT flag, even once it is granted the EXECUTE privilege it needs in
-- production. Check 7 (anon_privileges, which has no such exemption) gets a
-- matching self-test proving the same probe IS flagged the moment anon is
-- granted EXECUTE on it, same as any other function.
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
-- corrupt its expected result. Probe names are chosen so no probe's name is
-- a substring of another probe's name.
--
-- pgTAP lives in: `select extnamespace::regnamespace from pg_extension where
-- extname = 'pgtap'`. Locally the Supabase CLI installs it into `extensions`,
-- not `public` or `private`, so it never reaches the `nspname in
-- ('public','private')` scope of the function-based checks below in the
-- first place. Even if a future environment installed it into `public`,
-- every pgTAP function is owned by the `pgtap` extension
-- (`pg_depend.deptype = 'e'`), which those checks explicitly exclude --
-- so the exclusion covers that case too.
--
-- SECURITY DEFINER rules, enforced by checks 4-6 and 11-13:
--   * allowed at all: `private.notebook_role(uuid)` (see its ADR) and,
--     later, PR 3's trigger functions. Matched by OID via `to_regprocedure`
--     (null-safe when the function does not exist yet), never by formatting
--     a signature string -- `pg_get_function_identity_arguments` includes
--     parameter *names* (e.g. a real `notebook_role(p_notebook_id uuid)`
--     renders as "p_notebook_id uuid", not "uuid"), so a naive text
--     comparison against a hand-written 'private.notebook_role(uuid)'
--     silently stops matching the moment someone names a parameter. Every
--     identifier string in this file therefore uses `oidvectortypes`
--     (types only, no names) instead.
--   * must live in schema `private` (check 11), never `public`.
--   * must set `search_path` to exactly `search_path=""` (check 12) --
--     confirmed by direct inspection of `pg_proc.proconfig` for a function
--     created with `set search_path = ''`.
--   * must not be executable by PUBLIC, `anon` or `authenticated` (check 13),
--     except `private.notebook_role(uuid)` itself, which RLS policies call
--     while running as the querying role and therefore needs EXECUTE from
--     at least `authenticated`; PR 3 grants that explicitly.
--   * trigger functions (allowed check 4 only when they return trigger,
--     checked in 11-13 like everything else): none yet. PR 3 adds the
--     membership audit/guard triggers it introduces here as
--     `to_regprocedure('<schema>.<trigger_function_name>()')` entries, once
--     they exist and their exact names are known.

begin;

select plan(49);

-- ---------------------------------------------------------------------------
-- Check definitions
-- ---------------------------------------------------------------------------

-- 1. rls_disabled: every ordinary/partitioned table in public has RLS on,
-- including partitions themselves -- enabling RLS on a partitioned root does
-- NOT propagate relrowsecurity to its partitions (confirmed empirically), so
-- a partition accessed directly would otherwise bypass RLS entirely.
create function pg_temp.check_rls_disabled() returns setof text as $$
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relrowsecurity = false;
$$ language sql;

-- 2. missing_policies: every public table (including partitions, see check 1)
-- has >=1 PERMISSIVE policy for each of select/insert/update/delete. A
-- restrictive-only policy does not count: with no permissive policy at all,
-- Postgres denies every row regardless of what restrictive policies say. A
-- `for all` policy (polcmd = '*') counts for every command; check 3
-- separately forbids `for all` policies from existing at all, so in practice
-- a table must have four distinct permissive policies.
create function pg_temp.check_missing_policies() returns setof text as $$
  with tables as (
    select c.oid, n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
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
      and p.polpermissive
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
-- documented at the top of this file, matched by OID, not by signature text.
create function pg_temp.check_security_definer_allowlist() returns setof text as $$
  with allowed_trigger_procs as (
    -- PR 3 adds allowed trigger function OIDs here via
    -- to_regprocedure('<schema>.<trigger_function_name>()') once they exist.
    select unnest(array[]::regprocedure[]) as proc
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

-- 5. security_definer_returns_trigger: every SECURITY DEFINER function in
-- public or private, other than private.notebook_role(uuid), returns trigger.
create function pg_temp.check_security_definer_returns_trigger() returns setof text as $$
  select sig
  from (
    select p.oid,
           n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig,
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
  where f.oid::regprocedure is distinct from to_regprocedure('private.notebook_role(uuid)')
    and f.prorettype <> 'trigger'::regtype;
$$ language sql;

-- 6. missing_search_path: every function/procedure in public or private
-- (excluding extension members) sets search_path explicitly (any value --
-- check 12 separately requires SECURITY DEFINER functions to set it to the
-- exact empty string).
create function pg_temp.check_missing_search_path() returns setof text as $$
  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
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

-- 7. anon_privileges: `anon` has no privilege (table-level, column-level or,
-- for sequences, sequence-level) on any public table, partitioned table,
-- view, matview, foreign table or sequence, no USAGE on schema private, and
-- no EXECUTE on any function in private. Uses has_table_privilege /
-- has_any_column_privilege / has_sequence_privilege / has_schema_privilege /
-- has_function_privilege (which account for PUBLIC grants and role
-- membership, unlike inspecting relacl for an exact grantee match) rather
-- than aclexplode on a named role -- a bare `grant ... to public`, or a
-- brand new object that simply inherits Postgres/Supabase default
-- privileges, must still be caught. Sequences get their own branch:
-- has_any_column_privilege technically still returns a (correct, but
-- table-ACL-derived rather than genuinely column-level) answer for them,
-- since a sequence has no grantable columns -- has_sequence_privilege is the
-- precise, documented way to ask the question for relkind S. has_sequence_
-- privilege raises a hard error when called on a non-sequence oid, and
-- Postgres does not guarantee AND/OR short-circuit evaluation order (it is
-- documented as unspecified) -- confirmed the hard way: pairing `relkind =
-- 'S' and has_sequence_privilege(...)` in one WHERE clause still raised
-- "... is not a sequence" for an ordinary table, because the planner
-- evaluated the function before the relkind filter. CASE WHEN is the
-- Postgres-documented way to force evaluation order, so every call below is
-- guarded that way instead. If `private` does not exist yet those parts are
-- simply empty (the join against pg_namespace finds nothing).
create function pg_temp.check_anon_privileges() returns setof text as $$
  with rels as (
    select c.oid, n.nspname, c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  ),
  flagged_tables as (
    select nspname || '.' || relname as sig
    from rels
    where
      case when relkind <> 'S' then
        has_table_privilege('anon', oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      end
      or
      case when relkind <> 'S' then
        has_any_column_privilege('anon', oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      end
  ),
  flagged_sequences as (
    select nspname || '.' || relname as sig
    from rels
    where case when relkind = 'S' then
      has_sequence_privilege('anon', oid, 'USAGE,SELECT,UPDATE')
    end
  ),
  schema_usage as (
    select n.nspname as sig
    from pg_namespace n
    where n.nspname = 'private'
      and has_schema_privilege('anon', n.oid, 'USAGE')
  ),
  fn_exec as (
    select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
      )
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  )
  select sig from flagged_tables
  union all
  select sig from flagged_sequences
  union all
  select sig from schema_usage
  union all
  select sig from fn_exec;
$$ language sql;

-- 8. authenticated_private_privileges: `authenticated` has no table-level,
-- column-level or sequence-level privilege on any relation in schema
-- private. Using has_table_privilege/has_any_column_privilege/
-- has_sequence_privilege means a grant made `to public` is caught too, since
-- `authenticated` inherits whatever PUBLIC has. See check 7 for why
-- sequences get their own has_sequence_privilege branch.
create function pg_temp.check_authenticated_private_privileges() returns setof text as $$
  with rels as (
    select c.oid, n.nspname, c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  )
  select nspname || '.' || relname
  from rels
  where
    case when relkind <> 'S' then
      has_table_privilege('authenticated', oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    end
    or
    case when relkind <> 'S' then
      has_any_column_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    end
    or
    case when relkind = 'S' then
      has_sequence_privilege('authenticated', oid, 'USAGE,SELECT,UPDATE')
    end;
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

-- 10. user_metadata_in_policies: no policy in public, and no function body in
-- public/private (excluding extension members), reads user_metadata /
-- raw_user_meta_data (roles must come from app_metadata, never
-- client-writable).
create function pg_temp.check_user_metadata_in_policies() returns setof text as $$
  select n.nspname || '.' || c.relname || ':' || p.polname
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~* 'user_metadata|raw_user_meta_data'
      or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'user_metadata|raw_user_meta_data'
    )
  union all
  select n.nspname || '.' || pr.proname || '(' || oidvectortypes(pr.proargtypes) || ')'
  from pg_proc pr
  join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname in ('public', 'private')
    and not exists (
      select 1 from pg_depend d
      where d.objid = pr.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and coalesce(pr.prosrc, '') ~* 'user_metadata|raw_user_meta_data';
$$ language sql;

-- 11. security_definer_location: every SECURITY DEFINER function in public or
-- private (excluding extension members) lives in schema private.
create function pg_temp.check_security_definer_location() returns setof text as $$
  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosecdef
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and n.nspname <> 'private';
$$ language sql;

-- 12. security_definer_search_path: every SECURITY DEFINER function in
-- public or private (excluding extension members) sets search_path to
-- exactly the empty string. Confirmed by direct inspection: a function
-- created with `set search_path = ''` has proconfig = {"search_path=\"\""},
-- i.e. the single text element 'search_path=""' -- not merely "present".
create function pg_temp.check_security_definer_search_path() returns setof text as $$
  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosecdef
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and not ('search_path=""' = any(coalesce(p.proconfig, '{}')));
$$ language sql;

-- 13. security_definer_execute_grants: no SECURITY DEFINER function in public
-- or private (excluding extension members), other than
-- private.notebook_role(uuid), is executable by PUBLIC, anon or
-- authenticated. has_function_privilege covers anon/authenticated (including
-- anything they inherit from PUBLIC); a freshly created function has
-- proacl = NULL, which means "apply the built-in default" -- EXECUTE granted
-- to PUBLIC -- so NULL must be treated as a violation too, alongside an
-- explicit PUBLIC grant (grantee 0) in a non-null proacl.
create function pg_temp.check_security_definer_execute_grants() returns setof text as $$
  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosecdef
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and p.oid::regprocedure is distinct from to_regprocedure('private.notebook_role(uuid)')
    and (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or p.proacl is null
      or exists (
        select 1 from aclexplode(p.proacl) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
    );
$$ language sql;

-- 14. no_matviews_or_foreign_tables_in_public: materialized views and foreign
-- tables cannot carry row level security at all, so none may exist in public.
create function pg_temp.check_no_matviews_or_foreign_tables_in_public() returns setof text as $$
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('m', 'f');
$$ language sql;

-- ---------------------------------------------------------------------------
-- 1) Real catalog: every check must be empty. Run first, before any probes
-- exist, so a probe from one check's self-test can never taint another
-- check's "is empty" assertion.
-- ---------------------------------------------------------------------------

select is_empty(
  'select * from pg_temp.check_rls_disabled()',
  'every public table (including partitions) has row level security enabled'
);
select is_empty(
  'select * from pg_temp.check_missing_policies()',
  'every public table has permissive select/insert/update/delete policies'
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
  'select * from pg_temp.check_anon_privileges()',
  'anon has no privilege in public and no access to private'
);
select is_empty(
  'select * from pg_temp.check_authenticated_private_privileges()',
  'authenticated has no privilege on any relation in schema private'
);
select is_empty(
  'select * from pg_temp.check_views_not_security_invoker()',
  'every view in public is security_invoker'
);
select is_empty(
  'select * from pg_temp.check_user_metadata_in_policies()',
  'no public policy or public/private function body reads user_metadata or raw_user_meta_data'
);
select is_empty(
  'select * from pg_temp.check_security_definer_location()',
  'every SECURITY DEFINER function in public/private lives in private'
);
select is_empty(
  'select * from pg_temp.check_security_definer_search_path()',
  'every SECURITY DEFINER function in public/private sets an exact empty search_path'
);
select is_empty(
  'select * from pg_temp.check_security_definer_execute_grants()',
  'no SECURITY DEFINER function other than notebook_role is executable by PUBLIC/anon/authenticated'
);
select is_empty(
  'select * from pg_temp.check_no_matviews_or_foreign_tables_in_public()',
  'no materialized views or foreign tables exist in public'
);

-- ---------------------------------------------------------------------------
-- 2) Negative and positive self-tests: prove each check actually bites, and
-- that the notebook_role exemptions actually hold for a realistically-shaped
-- function. Probes are never rolled back mid-file (see header), so every
-- assertion below filters the check's output down to rows containing that
-- probe's own unique `catalog_probe_<name>` substring.
-- ---------------------------------------------------------------------------

-- check_rls_disabled: a plain table without RLS.
create table public.catalog_probe_rls_disabled (id int);
select set_eq(
  $sql$
    select * from pg_temp.check_rls_disabled() as v
    where v like '%catalog_probe_rls_disabled%'
  $sql$,
  array['public.catalog_probe_rls_disabled'],
  'rls_disabled flags a table without row level security enabled'
);

-- check_rls_disabled: a partition does not inherit relrowsecurity from its
-- partitioned root, so both must be flagged independently.
create table public.catalog_probe_rls_partition_root (id int) partition by range (id);
create table public.catalog_probe_rls_partition_leaf partition of public.catalog_probe_rls_partition_root
  for values from (0) to (100);
select set_eq(
  $sql$
    select * from pg_temp.check_rls_disabled() as v
    where v like '%catalog_probe_rls_partition%'
  $sql$,
  array[
    'public.catalog_probe_rls_partition_root',
    'public.catalog_probe_rls_partition_leaf'
  ],
  'rls_disabled flags a partition even though its partitioned root is also flagged separately'
);

-- check_missing_policies: only a select policy exists.
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

-- check_missing_policies: a partition has no policies of its own even though
-- its partitioned root has all four -- pg_policy is keyed by relid, and
-- policies on the root are not copied onto partitions.
create table public.catalog_probe_policy_partition_root (id int) partition by range (id);
alter table public.catalog_probe_policy_partition_root enable row level security;
create policy catalog_probe_policy_partition_root_select on public.catalog_probe_policy_partition_root
  for select using (true);
create policy catalog_probe_policy_partition_root_insert on public.catalog_probe_policy_partition_root
  for insert with check (true);
create policy catalog_probe_policy_partition_root_update on public.catalog_probe_policy_partition_root
  for update using (true);
create policy catalog_probe_policy_partition_root_delete on public.catalog_probe_policy_partition_root
  for delete using (true);
create table public.catalog_probe_policy_partition_leaf
  partition of public.catalog_probe_policy_partition_root for values from (0) to (100);
select set_eq(
  $sql$
    select * from pg_temp.check_missing_policies() as v
    where v like '%catalog_probe_policy_partition_leaf%'
  $sql$,
  array[
    'public.catalog_probe_policy_partition_leaf:select',
    'public.catalog_probe_policy_partition_leaf:insert',
    'public.catalog_probe_policy_partition_leaf:update',
    'public.catalog_probe_policy_partition_leaf:delete'
  ],
  'missing_policies flags a partition that has no policies of its own even though its root does'
);

-- check_missing_policies: a RESTRICTIVE-only policy does not satisfy the
-- requirement for any command.
create table public.catalog_probe_restrictive_only (id int);
alter table public.catalog_probe_restrictive_only enable row level security;
create policy catalog_probe_restrictive_only_policy on public.catalog_probe_restrictive_only
  as restrictive for select using (true);
select set_eq(
  $sql$
    select * from pg_temp.check_missing_policies() as v
    where v like '%catalog_probe_restrictive_only%'
  $sql$,
  array[
    'public.catalog_probe_restrictive_only:select',
    'public.catalog_probe_restrictive_only:insert',
    'public.catalog_probe_restrictive_only:update',
    'public.catalog_probe_restrictive_only:delete'
  ],
  'missing_policies flags every command when only a RESTRICTIVE policy exists'
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

-- check_security_definer_location: a SECURITY DEFINER function living in
-- public (not private) is flagged, even though it is otherwise well-formed
-- (returns trigger, empty search_path, execute revoked from public).
create function public.catalog_probe_secdef_wrong_schema() returns trigger
  language plpgsql security definer set search_path = '' as $body$
  begin
    return new;
  end;
$body$;
revoke execute on function public.catalog_probe_secdef_wrong_schema() from public;
select set_eq(
  $sql$
    select * from pg_temp.check_security_definer_location() as v
    where v like '%catalog_probe_secdef_wrong_schema%'
  $sql$,
  array['public.catalog_probe_secdef_wrong_schema()'],
  'security_definer_location flags a SECURITY DEFINER function living outside schema private'
);

-- check_security_definer_search_path: a SECURITY DEFINER function with a
-- non-empty search_path is flagged, even though it is otherwise well-formed
-- (lives in private, returns trigger, execute revoked from public).
create function private.catalog_probe_secdef_bad_search_path() returns trigger
  language plpgsql security definer set search_path = pg_catalog as $body$
  begin
    return new;
  end;
$body$;
revoke execute on function private.catalog_probe_secdef_bad_search_path() from public;
select set_eq(
  $sql$
    select * from pg_temp.check_security_definer_search_path() as v
    where v like '%catalog_probe_secdef_bad_search_path%'
  $sql$,
  array['private.catalog_probe_secdef_bad_search_path()'],
  'security_definer_search_path flags a SECURITY DEFINER function without an exact empty search_path'
);

-- POSITIVE self-test: a realistically-shaped notebook_role -- named
-- parameter, lives in private, empty search_path -- must NOT be flagged by
-- the checks that exempt it. Only create it if PR 3's real migration has not
-- landed yet: `create or replace` here would otherwise silently overwrite
-- the real function's body (and could error outright if PR 3 gives it a
-- different return type), so the probe is created solely inside this `if
-- ... is null` guard. Either way -- probe or the real thing -- every
-- assertion below runs against whatever `private.notebook_role(uuid)` now
-- resolves to.
do $do$
begin
  if to_regprocedure('private.notebook_role(uuid)') is null then
    create schema if not exists private;
    execute $create$
      create function private.notebook_role(p_notebook_id uuid) returns text
        language plpgsql security definer set search_path = ''
      as $body$
        begin
          return 'owner';
        end;
      $body$;
    $create$;
  end if;
end;
$do$;

-- Baseline: nobody can execute it yet.
revoke execute on function private.notebook_role(uuid) from public, anon, authenticated;

select is_empty(
  $sql$ select * from pg_temp.check_security_definer_allowlist() as v where v like '%notebook_role%' $sql$,
  'security_definer_allowlist does not flag the real notebook_role(uuid) shape (matched by OID, not by a named-parameter signature string)'
);
select is_empty(
  $sql$ select * from pg_temp.check_security_definer_returns_trigger() as v where v like '%notebook_role%' $sql$,
  'security_definer_returns_trigger exempts notebook_role(uuid) even though it does not return trigger'
);
select is_empty(
  $sql$ select * from pg_temp.check_security_definer_location() as v where v like '%notebook_role%' $sql$,
  'security_definer_location does not flag notebook_role(uuid) because it lives in private'
);
select is_empty(
  $sql$ select * from pg_temp.check_security_definer_search_path() as v where v like '%notebook_role%' $sql$,
  'security_definer_search_path does not flag notebook_role(uuid) because it sets an exact empty search_path'
);

-- Grant execute to authenticated: the realistic production grant, since RLS
-- policies call notebook_role while running as the querying role.
grant execute on function private.notebook_role(uuid) to authenticated;

select is_empty(
  $sql$ select * from pg_temp.check_security_definer_execute_grants() as v where v like '%notebook_role%' $sql$,
  'security_definer_execute_grants does not flag notebook_role(uuid) even though authenticated is granted execute (the one function allowed to be callable)'
);
select is_empty(
  $sql$ select * from pg_temp.check_anon_privileges() as v where v like '%notebook_role%' $sql$,
  'anon_privileges does not flag notebook_role(uuid) while anon has no execute on it'
);

-- anon_privileges has no special exemption for notebook_role the way the
-- SECURITY DEFINER checks do: granting anon execute must still be flagged.
grant execute on function private.notebook_role(uuid) to anon;
select set_eq(
  $sql$ select * from pg_temp.check_anon_privileges() as v where v like '%notebook_role%' $sql$,
  array['private.notebook_role(uuid)'],
  'anon_privileges flags notebook_role(uuid) once anon is granted execute, same as any other function'
);
revoke execute on function private.notebook_role(uuid) from anon;

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

-- check_anon_privileges: an explicit grant to anon (not relying on
-- Supabase's default privileges, which PR 3 revokes).
create table public.catalog_probe_grants (id int);
grant select on public.catalog_probe_grants to anon;
select set_eq(
  $sql$
    select * from pg_temp.check_anon_privileges() as v
    where v like '%catalog_probe_grants%'
  $sql$,
  array['public.catalog_probe_grants'],
  'anon_privileges flags a public table explicitly granted to anon'
);

-- check_anon_privileges: USAGE on schema private granted to anon.
create schema if not exists private;
grant usage on schema private to anon;
select set_eq(
  $sql$ select * from pg_temp.check_anon_privileges() as v where v = 'private' $sql$,
  array['private'],
  'anon_privileges flags USAGE on schema private granted to anon'
);

-- check_anon_privileges: a private function with no explicit grants at
-- all. Postgres defaults new functions to PUBLIC-executable, so anon gets
-- EXECUTE through PUBLIC unless it is explicitly revoked.
create function private.catalog_probe_fn_default_acl() returns int
  language sql as $body$ select 1; $body$;
select set_eq(
  $sql$
    select * from pg_temp.check_anon_privileges() as v
    where v like '%catalog_probe_fn_default_acl%'
  $sql$,
  array['private.catalog_probe_fn_default_acl()'],
  'anon_privileges flags a private function with default (PUBLIC-executable) ACL'
);

-- check_anon_privileges: a column-level grant with no table-level grant.
create table public.catalog_probe_column_grant (id int, secret text);
grant select (secret) on public.catalog_probe_column_grant to anon;
select set_eq(
  $sql$
    select * from pg_temp.check_anon_privileges() as v
    where v like '%catalog_probe_column_grant%'
  $sql$,
  array['public.catalog_probe_column_grant'],
  'anon_privileges flags a column-level grant to anon even without a table-level grant'
);

-- check_anon_privileges: a partitioned table (relkind p) granted to
-- anon, not just an ordinary table.
create table public.catalog_probe_partition_grant (id int) partition by range (id);
grant select on public.catalog_probe_partition_grant to anon;
select set_eq(
  $sql$
    select * from pg_temp.check_anon_privileges() as v
    where v like '%catalog_probe_partition_grant%'
  $sql$,
  array['public.catalog_probe_partition_grant'],
  'anon_privileges flags a partitioned table (relkind p) granted to anon'
);

-- check_anon_privileges: a sequence granted to anon. Sequences are checked
-- via has_sequence_privilege, a separate branch from ordinary tables/views.
create sequence public.catalog_probe_seq;
grant usage on sequence public.catalog_probe_seq to anon;
select set_eq(
  $sql$
    select * from pg_temp.check_anon_privileges() as v
    where v like '%catalog_probe_seq%'
  $sql$,
  array['public.catalog_probe_seq'],
  'anon_privileges flags a sequence granted to anon'
);

-- check_anon_privileges: MAINTAIN (added in PG17) granted to anon, with every
-- other privilege explicitly revoked first. The current has_table_privilege
-- list predates MAINTAIN, so a MAINTAIN-only grant must still be flagged, not
-- silently waved through because it isn't SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER.
create table public.catalog_probe_maintain_anon (id int);
revoke all privileges on public.catalog_probe_maintain_anon from public, anon, authenticated;
grant maintain on public.catalog_probe_maintain_anon to anon;
select set_eq(
  $sql$
    select * from pg_temp.check_anon_privileges() as v
    where v like '%catalog_probe_maintain_anon%'
  $sql$,
  array['public.catalog_probe_maintain_anon'],
  'anon_privileges flags a MAINTAIN-only grant to anon (PG17 privilege, not in the old has_table_privilege list)'
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

-- check_authenticated_private_privileges: a grant `to public` is also caught,
-- since `authenticated` inherits whatever PUBLIC has.
create schema if not exists private;
create table private.catalog_probe_auth_pub_grant (id int);
grant select on private.catalog_probe_auth_pub_grant to public;
select set_eq(
  $sql$
    select * from pg_temp.check_authenticated_private_privileges() as v
    where v like '%catalog_probe_auth_pub_grant%'
  $sql$,
  array['private.catalog_probe_auth_pub_grant'],
  'authenticated_private_privileges flags a private table granted to PUBLIC'
);

-- check_authenticated_private_privileges: a sequence in private granted to
-- authenticated, checked via has_sequence_privilege (see check 7).
create schema if not exists private;
create sequence private.catalog_probe_auth_seq;
grant usage on sequence private.catalog_probe_auth_seq to authenticated;
select set_eq(
  $sql$
    select * from pg_temp.check_authenticated_private_privileges() as v
    where v like '%catalog_probe_auth_seq%'
  $sql$,
  array['private.catalog_probe_auth_seq'],
  'authenticated_private_privileges flags a private sequence granted to authenticated'
);

-- check_authenticated_private_privileges: MAINTAIN (added in PG17) granted to
-- authenticated, with every other privilege explicitly revoked first. Same
-- gap as the anon check above: MAINTAIN predates the current
-- has_table_privilege list.
create schema if not exists private;
create table private.catalog_probe_maintain_auth (id int);
revoke all privileges on private.catalog_probe_maintain_auth from public, anon, authenticated;
grant maintain on private.catalog_probe_maintain_auth to authenticated;
select set_eq(
  $sql$
    select * from pg_temp.check_authenticated_private_privileges() as v
    where v like '%catalog_probe_maintain_auth%'
  $sql$,
  array['private.catalog_probe_maintain_auth'],
  'authenticated_private_privileges flags a MAINTAIN-only grant to authenticated (PG17 privilege, not in the old has_table_privilege list)'
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

-- check_user_metadata_in_policies: a policy that reads user_metadata.
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

-- check_user_metadata_in_policies: a function body that reads user_metadata.
create function public.catalog_probe_meta_fn() returns text
  language sql as $body$ select 'user_metadata'; $body$;
select set_eq(
  $sql$
    select * from pg_temp.check_user_metadata_in_policies() as v
    where v like '%catalog_probe_meta_fn%'
  $sql$,
  array['public.catalog_probe_meta_fn()'],
  'user_metadata_in_policies flags a function whose body mentions user_metadata'
);

-- check_security_definer_execute_grants: EXECUTE granted to anon, to
-- authenticated, and the default (untouched) PUBLIC-executable ACL -- all
-- three distinct ways a SECURITY DEFINER function can end up callable.
create function private.catalog_probe_secdef_exec_anon() returns trigger
  language plpgsql security definer set search_path = '' as $body$
  begin
    return new;
  end;
$body$;
revoke execute on function private.catalog_probe_secdef_exec_anon() from public;
grant execute on function private.catalog_probe_secdef_exec_anon() to anon;

create function private.catalog_probe_secdef_exec_authenticated() returns trigger
  language plpgsql security definer set search_path = '' as $body$
  begin
    return new;
  end;
$body$;
revoke execute on function private.catalog_probe_secdef_exec_authenticated() from public;
grant execute on function private.catalog_probe_secdef_exec_authenticated() to authenticated;

create function private.catalog_probe_secdef_exec_default() returns trigger
  language plpgsql security definer set search_path = '' as $body$
  begin
    return new;
  end;
$body$;
-- no grant/revoke at all: default ACL leaves EXECUTE to PUBLIC.

select set_eq(
  $sql$
    select * from pg_temp.check_security_definer_execute_grants() as v
    where v like '%catalog_probe_secdef_exec_%'
  $sql$,
  array[
    'private.catalog_probe_secdef_exec_anon()',
    'private.catalog_probe_secdef_exec_authenticated()',
    'private.catalog_probe_secdef_exec_default()'
  ],
  'security_definer_execute_grants flags execute granted to anon, to authenticated, and default PUBLIC execute'
);

-- check_no_matviews_or_foreign_tables_in_public: a materialized view.
create materialized view public.catalog_probe_matview as select 1 as id;
select set_eq(
  $sql$
    select * from pg_temp.check_no_matviews_or_foreign_tables_in_public() as v
    where v like '%catalog_probe_matview%'
  $sql$,
  array['public.catalog_probe_matview'],
  'no_matviews_or_foreign_tables_in_public flags a materialized view in public'
);

-- check_no_matviews_or_foreign_tables_in_public: a foreign table. The DDL
-- alone is enough for the catalog check; nothing here ever connects to a
-- remote server.
create extension if not exists postgres_fdw;
create server catalog_probe_fdw_server foreign data wrapper postgres_fdw;
create foreign table public.catalog_probe_foreign_table (id int) server catalog_probe_fdw_server;
select set_eq(
  $sql$
    select * from pg_temp.check_no_matviews_or_foreign_tables_in_public() as v
    where v like '%catalog_probe_foreign_table%'
  $sql$,
  array['public.catalog_probe_foreign_table'],
  'no_matviews_or_foreign_tables_in_public flags a foreign table in public'
);

select * from finish();

rollback;
