-- Private Storage bucket for source files, with object policies that follow the same
-- role rules as public.sources. Decisions: docs/adr/0004-sources-chunks-messages.md.

-- Created here, not in config.toml, so it reaches develop and production through the
-- migration. The MIME allowlist is what the client claims; PR C checks magic bytes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sources', 'sources', false, 20971520, array['application/pdf', 'text/plain'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Every policy looks up the source row by its generated storage_path ({notebook_id}/{id})
-- instead of parsing the object name, so a malformed name matches no row and is denied
-- without a cast error. The lookup runs under the caller's RLS on sources, and the role
-- check uses the row's notebook_id. An object without a source row (an orphan upload, or
-- a leftover after the row was deleted) is neither writable nor readable; the cleanup
-- job in PR C removes leftovers.

create policy sources_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'sources'
    and exists (
      select 1 from public.sources s
      where s.storage_path = objects.name
        and private.notebook_role(s.notebook_id) is not null
    )
  );

create policy sources_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'sources'
    and exists (
      select 1 from public.sources s
      where s.storage_path = objects.name
        and private.notebook_role(s.notebook_id) in ('owner', 'editor')
    )
  );

-- No update policy: an object is never overwritten (no upsert), so the file always
-- matches its chunks.

create policy sources_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'sources'
    and exists (
      select 1 from public.sources s
      where s.storage_path = objects.name
        and private.notebook_role(s.notebook_id) in ('owner', 'editor')
    )
  );

-- Anonymous (demo) users do not upload or delete files (ADR 0004; PR F decides).
create policy sources_objects_insert_not_anonymous on storage.objects
  as restrictive
  for insert to authenticated
  with check (
    bucket_id <> 'sources'
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

create policy sources_objects_delete_not_anonymous on storage.objects
  as restrictive
  for delete to authenticated
  using (
    bucket_id <> 'sources'
    or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );
