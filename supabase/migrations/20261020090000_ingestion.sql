-- Ingestion (PR C1): failure category and status timestamp on sources, and the per-notebook
-- caps on sources (50) and chunks (20,000). Expand-only: new nullable or defaulted
-- columns and invoker triggers, so the previous app version keeps working.
-- Decisions: docs/adr/0007-ingestion-pipeline.md.

-- Columns -----------------------------------------------------------------------------

-- The fixed category (lib/ops/categories.ts) of the last failed ingest. Only a failed
-- source has one, so a stale category never sits next to "ready".
alter table public.sources
  add column error_category text
    constraint sources_error_category_format check (error_category ~ '^[a-z_]{1,40}$'),
  add column status_changed_at timestamptz not null default now(),
  add constraint sources_error_category_only_failed
    check (status = 'failed' or error_category is null);

-- status_changed_at is set by the trigger below only, so a stuck "processing" source
-- cannot be made to look fresh or stale from the API.
grant update (error_category) on public.sources to authenticated;

-- Triggers ----------------------------------------------------------------------------

-- Every status write stamps the time, also processing -> processing (a stale claim).
-- clock_timestamp(), not now(): the time of this write, also inside a long transaction.
create function private.touch_source_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.status_changed_at := clock_timestamp();
  return new;
end
$$;

revoke execute on function private.touch_source_status() from public, anon, authenticated;

create trigger sources_touch_status
  before update of status on public.sources
  for each row execute function private.touch_source_status();

-- At most 50 sources per notebook, against storage abuse by editors. The lock serializes
-- concurrent inserts into the same notebook, so two inserts cannot both pass at 49.
-- Invoker: only owners and editors can insert, and they see every source of the notebook.
create function private.enforce_notebook_source_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('sources:' || new.notebook_id::text, 0));
  if (select count(*) from public.sources where notebook_id = new.notebook_id) >= 50 then
    raise exception 'notebook_source_limit' using errcode = '54000';
  end if;
  return new;
end
$$;

revoke execute on function private.enforce_notebook_source_limit() from public, anon, authenticated;

create trigger sources_enforce_notebook_limit
  before insert on public.sources
  for each row execute function private.enforce_notebook_source_limit();

-- At most 20,000 chunks per notebook (ADR 0004, SECURITY.md): bounds the exact search in
-- match_chunks, and also bounds direct chunk inserts through PostgREST. Statement level,
-- with locks taken in notebook order, so batch inserts stay cheap and cannot deadlock.
create function private.enforce_notebook_chunk_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  nb uuid;
begin
  for nb in select distinct notebook_id from inserted order by notebook_id loop
    perform pg_advisory_xact_lock(hashtextextended('chunks:' || nb::text, 0));
    if (select count(*) from public.chunks where notebook_id = nb) > 20000 then
      raise exception 'notebook_chunk_limit' using errcode = '54000';
    end if;
  end loop;
  return null;
end
$$;

revoke execute on function private.enforce_notebook_chunk_limit() from public, anon, authenticated;

create trigger chunks_enforce_notebook_limit
  after insert on public.chunks
  referencing new table as inserted
  for each statement execute function private.enforce_notebook_chunk_limit();
