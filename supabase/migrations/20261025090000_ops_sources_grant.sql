-- The ops summary (ADR 0023) reads failed sources as service_role. The hosted projects give
-- service_role no default privileges on public.sources (the local stack does), so ops_summary
-- failed on develop with 42501. service_role now gets exactly the three columns the summary
-- counts, and nothing else, on every stack: no titles, paths or URLs.

revoke all on public.sources from service_role;
grant select (status, error_category, status_changed_at) on public.sources to service_role;
