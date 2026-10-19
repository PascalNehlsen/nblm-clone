-- Block F1: demo login, database part (ADR 0012). An anonymous user's first notebook gets a
-- copy of the registered demo template's ready sources and chunks (embeddings included, so
-- no model call); anonymous users and their data are deleted within 24 h 15 min; the two
-- 90-day retention jobs docs/privacy.md promises run daily. Expand-only: nothing changes for
-- non-anonymous users, and anonymous sign-in stays off on hosted projects until F2.

create extension if not exists pg_cron with schema pg_catalog;

-- Template -------------------------------------------------------------------------------

-- At most one row. Changed only by a human with SQL (runbook demo-template.md); no API role
-- can read or write it.
create table private.demo_template (
  id boolean primary key default true check (id),
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  max_live_copies integer not null default 100 check (max_live_copies between 1 and 1000),
  updated_at timestamptz not null default now(),
  updated_by text not null check (char_length(updated_by) between 1 and 100),
  reason text not null check (char_length(reason) between 1 and 500)
);

alter table private.demo_template enable row level security;

create policy demo_template_select on private.demo_template
  for select to authenticated using (false);
create policy demo_template_insert on private.demo_template
  for insert to authenticated with check (false);
create policy demo_template_update on private.demo_template
  for update to authenticated using (false) with check (false);
create policy demo_template_delete on private.demo_template
  for delete to authenticated using (false);

revoke all on private.demo_template from public, anon, authenticated;

-- Copy -----------------------------------------------------------------------------------

-- SECURITY DEFINER (ADR 0001, 0012): the anonymous caller can neither read the template nor
-- insert sources or chunks (restrictive policies), so an invoker copy is impossible. Bounded
-- to anonymous callers, to the one registered template, to one notebook per anonymous user
-- and to max_live_copies.
create function private.copy_demo_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_template uuid;
  v_max integer;
  v_source record;
  v_copy uuid;
begin
  -- Both flags: the claim of this request, and the account itself (a converted account can
  -- still hold an anonymous token for up to an hour).
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
     or not exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous is true) then
    return null;
  end if;

  -- One lock for all demo copies: the one-notebook and the cap checks below are reads, so
  -- without it parallel inserts would all pass. Each statement after the lock takes a fresh
  -- snapshot only under read committed.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.copy_demo_template needs read committed' using errcode = '25001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('private.demo_template:copy', 0));

  if exists (
    select 1 from public.notebook_members
     where user_id = v_uid and notebook_id <> new.id
  ) then
    raise exception 'demo_notebook_exists' using errcode = 'P0001';
  end if;

  select t.notebook_id, t.max_live_copies into v_template, v_max from private.demo_template t;
  if v_template is null then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;

  if (
    select count(*)
      from public.notebook_members m
      join auth.users u on u.id = m.user_id
     where m.role = 'owner' and u.is_anonymous is true and m.notebook_id <> new.id
  ) >= v_max then
    raise exception 'demo_capacity' using errcode = 'P0001';
  end if;

  -- One source at a time (a template has at most 50): no temporary table, which a definer
  -- function would resolve through pg_temp first.
  for v_source in
    select s.id, s.kind, s.title, s.source_url
      from public.sources s
     where s.notebook_id = v_template and s.status = 'ready'
     order by s.created_at, s.id
  loop
    insert into public.sources (notebook_id, kind, title, source_url, status, created_by)
    values (new.id, v_source.kind, v_source.title, v_source.source_url, 'ready', v_uid)
    returning id into v_copy;

    insert into public.chunks (notebook_id, source_id, ordinal, content, page, embedding)
    select new.id, v_copy, c.ordinal, c.content, c.page, c.embedding
      from public.chunks c
     where c.source_id = v_source.id;
  end loop;

  return null;
end;
$$;

revoke execute on function private.copy_demo_template() from public, anon, authenticated;

-- After notebooks_add_owner (triggers of one event fire in name order).
create trigger notebooks_copy_demo_template
  after insert on public.notebooks
  for each row execute function private.copy_demo_template();

-- Purge and retention (run by pg_cron as postgres) ------------------------------------------

create function private.purge_expired_demo_users()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch uuid[];
  v_deleted integer;
begin
  select coalesce(array_agg(id), '{}') into v_batch
    from (
      select u.id from auth.users u
       where u.is_anonymous is true and u.created_at < now() - interval '24 hours'
       order by u.created_at
       limit 200
    ) expired;

  if cardinality(v_batch) = 0 then
    return 0;
  end if;

  -- Notebooks owned only by users of this batch; the cascade removes sources, chunks,
  -- messages, citations and members, so the last-owner guard never blocks the user delete.
  delete from public.notebooks n
   where exists (
           select 1 from public.notebook_members m
            where m.notebook_id = n.id and m.role = 'owner' and m.user_id = any (v_batch)
         )
     and not exists (
           select 1 from public.notebook_members m
            where m.notebook_id = n.id and m.role = 'owner' and m.user_id <> all (v_batch)
         );

  delete from auth.users u where u.id = any (v_batch) and u.is_anonymous is true;
  get diagnostics v_deleted = row_count;

  -- After the user delete: its cascade on notebook_members (memberships in notebooks that
  -- survive) writes audit rows of its own, which must lose the ids too.
  update private.membership_audit set user_id = null where user_id = any (v_batch);
  update private.membership_audit set actor = null where actor = any (v_batch);
  return v_deleted;
end;
$$;

revoke execute on function private.purge_expired_demo_users() from public, anon, authenticated;

create function private.purge_old_membership_audit()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.membership_audit where at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function private.purge_old_membership_audit() from public, anon, authenticated;

-- Cost, tokens, status and timing stay for aggregates; who, where and which message go.
create function private.anonymize_old_usage()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update private.usage
     set user_id = null, notebook_id = null, message_id = null
   where created_at < now() - interval '90 days'
     and (user_id is not null or notebook_id is not null or message_id is not null);
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke execute on function private.anonymize_old_usage() from public, anon, authenticated;

select cron.schedule('nblm-purge-demo-users', '*/15 * * * *', 'select private.purge_expired_demo_users()');
select cron.schedule('nblm-membership-audit-retention', '17 3 * * *', 'select private.purge_old_membership_audit()');
select cron.schedule('nblm-usage-retention', '27 3 * * *', 'select private.anonymize_old_usage()');
