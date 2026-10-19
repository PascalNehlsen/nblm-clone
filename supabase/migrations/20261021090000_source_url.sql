-- URL import (PR C2): the page address of a url source. Expand-only: a nullable column and
-- checks the previous app version (pdf and text rows, no source_url) always passes.
-- Decisions: docs/adr/0008-ssrf-guard.md.

alter table public.sources
  add column source_url text,
  add constraint sources_source_url_format
    check (source_url is null or (char_length(source_url) <= 2048 and source_url ~ '^https?://')),
  add constraint sources_source_url_only_url
    check (kind = 'url' or source_url is null);

-- NOT VALID: rows of kind 'url' inserted through PostgREST since A1 (the kind grant
-- existed) must not fail the migration. New inserts and every later update are checked;
-- such legacy rows can only be deleted.
alter table public.sources
  add constraint sources_url_has_source_url
    check (kind <> 'url' or source_url is not null) not valid;

-- Insert only: the address of a source never changes (no update grant).
grant insert (source_url) on public.sources to authenticated;
