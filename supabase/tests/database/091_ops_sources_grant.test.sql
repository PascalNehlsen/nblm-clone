-- Ops page: service_role's privileges on public.sources.
--
-- Contract pinned here (migration supabase/migrations/20261025090000_ops_sources_grant.sql):
--
--   service_role has no table-level privilege on public.sources and exactly SELECT on the three
--   columns ops_summary needs: status, error_category, status_changed_at. Nothing else: no other
--   column, no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER.
--
-- Why: the hosted Supabase project gives service_role no default privileges on public tables
-- while the local stack does, so 090 passed locally and `select public.ops_summary(7)` failed on
-- develop with 42501. The migration revokes everything and grants the three columns, so local and
-- hosted behave the same and the summary reads no title, path or address.
--
-- Everything runs in one transaction and is rolled back.
--
-- Red before the migration: the local stack grants service_role every privilege on public.sources.

begin;

select plan(22);

create function pg_temp.col_select(col text) returns boolean as $$
  select coalesce(has_column_privilege('service_role', to_regclass('public.sources'), col, 'SELECT'), false);
$$ language sql;

-- 'OK' when the statement ran as service_role, otherwise the SQLSTATE.
create function pg_temp.svc_sqlstate(probe text) returns text as $$
declare
  state text := 'OK';
begin
  set local role service_role;
  begin
    execute probe;
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
  end;
  reset role;
  return state;
end;
$$ language plpgsql;

-- A) The three columns the summary reads (3)

select ok(pg_temp.col_select('status'), 'service_role has SELECT on sources.status');
select ok(pg_temp.col_select('error_category'), 'service_role has SELECT on sources.error_category');
select ok(pg_temp.col_select('status_changed_at'), 'service_role has SELECT on sources.status_changed_at');

-- B) Nothing else is readable (9)

select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('public.sources'), 'SELECT'), true),
  'service_role has no table-level SELECT on public.sources'
);
select ok(not pg_temp.col_select('title'), 'service_role cannot SELECT sources.title');
select ok(not pg_temp.col_select('storage_path'), 'service_role cannot SELECT sources.storage_path');
select ok(not pg_temp.col_select('source_url'), 'service_role cannot SELECT sources.source_url');
select ok(not pg_temp.col_select('notebook_id'), 'service_role cannot SELECT sources.notebook_id');
select ok(not pg_temp.col_select('created_by'), 'service_role cannot SELECT sources.created_by');
select ok(not pg_temp.col_select('id'), 'service_role cannot SELECT sources.id');
select ok(not pg_temp.col_select('kind'), 'service_role cannot SELECT sources.kind');
select ok(not pg_temp.col_select('created_at'), 'service_role cannot SELECT sources.created_at');

-- C) Nothing is writable (5)

select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('public.sources'), 'INSERT'), true)
  and not coalesce(has_any_column_privilege('service_role', to_regclass('public.sources'), 'INSERT'), true),
  'service_role has no INSERT on public.sources (table or column level)'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('public.sources'), 'UPDATE'), true)
  and not coalesce(has_any_column_privilege('service_role', to_regclass('public.sources'), 'UPDATE'), true),
  'service_role has no UPDATE on public.sources (table or column level)'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('public.sources'), 'DELETE'), true),
  'service_role has no DELETE on public.sources'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('public.sources'), 'TRUNCATE'), true),
  'service_role has no TRUNCATE on public.sources'
);
select ok(
  not coalesce(has_table_privilege('service_role', to_regclass('public.sources'), 'REFERENCES,TRIGGER'), true)
  and not coalesce(has_any_column_privilege('service_role', to_regclass('public.sources'), 'REFERENCES'), true),
  'service_role has no REFERENCES or TRIGGER on public.sources'
);

-- D) Behaviour as service_role (5)

select is(
  pg_temp.svc_sqlstate('select status, error_category, status_changed_at from public.sources'),
  'OK',
  'service_role can select the three summary columns'
);
select is(
  pg_temp.svc_sqlstate('select title from public.sources'),
  '42501',
  'service_role selecting sources.title is denied (42501)'
);
select is(
  pg_temp.svc_sqlstate('select * from public.sources'),
  '42501',
  'service_role selecting * from public.sources is denied (42501)'
);
select is(
  pg_temp.svc_sqlstate('delete from public.sources'),
  '42501',
  'service_role deleting from public.sources is denied (42501)'
);
select is(
  pg_temp.svc_sqlstate('select public.ops_summary(7)'),
  'OK',
  'ops_summary(7) runs as service_role with only the three column grants'
);

select * from finish();

rollback;
