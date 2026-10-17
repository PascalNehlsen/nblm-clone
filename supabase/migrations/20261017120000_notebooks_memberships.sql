-- Notebooks with membership-based access (owner, editor, viewer), the one membership
-- helper, owner bootstrap, last-owner guard and the membership audit.
-- Decisions: docs/adr/0001-security-definer-membership-helper.md.

-- Default privileges first, so nothing below inherits Supabase's grants to anon.
-- The built-in EXECUTE for PUBLIC on new functions is global, so only the form without
-- `in schema` removes it; every function grant below is explicit.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
alter default privileges for role postgres revoke execute on functions from public;

create schema private;
revoke all on schema private from public, anon;
-- Policies call private.notebook_role; the API does not expose this schema (config.toml).
grant usage on schema private to authenticated;

create type public.member_role as enum ('owner', 'editor', 'viewer');

-- Tables -----------------------------------------------------------------------------

create table public.notebooks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.notebook_members (
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  created_at timestamptz not null default now(),
  primary key (notebook_id, user_id)
);

create index notebook_members_user_id_idx on public.notebook_members (user_id);

-- No foreign keys: the audit outlives deleted notebooks. User ids are nulled on account
-- deletion and rows expire after 90 days (later PRs, docs/privacy.md).
create table private.membership_audit (
  id bigint generated always as identity primary key,
  notebook_id uuid not null,
  user_id uuid,
  actor uuid,
  op text not null check (op in ('insert', 'update', 'delete')),
  old_role public.member_role,
  new_role public.member_role,
  at timestamptz not null default now()
);

alter table public.notebooks enable row level security;
alter table public.notebook_members enable row level security;
alter table private.membership_audit enable row level security;

-- Grants: column lists keep ids, creators and memberships' keys immutable from the API.
revoke all on public.notebooks, public.notebook_members from anon, authenticated;
revoke all on private.membership_audit from public, anon, authenticated;

grant select, delete on public.notebooks to authenticated;
grant insert (id, title) on public.notebooks to authenticated;
grant update (title) on public.notebooks to authenticated;

grant select, delete on public.notebook_members to authenticated;
grant insert (notebook_id, user_id, role) on public.notebook_members to authenticated;
grant update (role) on public.notebook_members to authenticated;

-- Membership helper ------------------------------------------------------------------

create function private.notebook_role(p_notebook_id uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.notebook_members m
  where m.notebook_id = p_notebook_id
    and m.user_id = (select auth.uid())
$$;

revoke execute on function private.notebook_role(uuid) from public, anon;
grant execute on function private.notebook_role(uuid) to authenticated;

-- Policies: notebooks ----------------------------------------------------------------

create policy notebooks_select on public.notebooks
  for select to authenticated
  using (private.notebook_role(id) is not null);

-- The creator becomes owner through the trigger below. No RETURNING on insert: the
-- membership does not exist yet when RETURNING is checked, so clients send their own id.
create policy notebooks_insert on public.notebooks
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy notebooks_update on public.notebooks
  for update to authenticated
  using (private.notebook_role(id) in ('owner', 'editor'))
  with check (private.notebook_role(id) in ('owner', 'editor'));

create policy notebooks_delete on public.notebooks
  for delete to authenticated
  using (private.notebook_role(id) = 'owner');

-- Policies: notebook_members ---------------------------------------------------------

create policy notebook_members_select on public.notebook_members
  for select to authenticated
  using (private.notebook_role(notebook_id) is not null);

create policy notebook_members_insert on public.notebook_members
  for insert to authenticated
  with check (private.notebook_role(notebook_id) = 'owner');

-- Anonymous (demo) users never add members, not even to their own notebook. Whether a
-- target user is anonymous is not visible to a policy; the invite flow checks that.
create policy notebook_members_insert_not_anonymous on public.notebook_members
  as restrictive
  for insert to authenticated
  with check (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

-- notebook_role is STABLE and reads the statement snapshot, so an owner may demote
-- themselves; the last-owner guard keeps at least one owner.
create policy notebook_members_update on public.notebook_members
  for update to authenticated
  using (private.notebook_role(notebook_id) = 'owner')
  with check (private.notebook_role(notebook_id) = 'owner');

-- Owners only: no self-leave for editors and viewers in v1.
create policy notebook_members_delete on public.notebook_members
  for delete to authenticated
  using (private.notebook_role(notebook_id) = 'owner');

-- Policies: membership_audit (deny all; only the definer trigger writes) -------------

create policy membership_audit_select on private.membership_audit
  for select to authenticated using (false);
create policy membership_audit_insert on private.membership_audit
  for insert to authenticated with check (false);
create policy membership_audit_update on private.membership_audit
  for update to authenticated using (false) with check (false);
create policy membership_audit_delete on private.membership_audit
  for delete to authenticated using (false);

-- Triggers ---------------------------------------------------------------------------

-- SECURITY DEFINER (ADR 0001): the creator is not a member yet, so the insert policy on
-- notebook_members would reject this row.
create function private.add_notebook_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'notebook creator unknown' using errcode = '42501';
  end if;
  insert into public.notebook_members (notebook_id, user_id, role)
  values (new.id, v_uid, 'owner');
  return new;
end;
$$;

revoke execute on function private.add_notebook_owner() from public, anon, authenticated;

create trigger notebooks_add_owner
  after insert on public.notebooks
  for each row execute function private.add_notebook_owner();

-- SECURITY DEFINER (ADR 0001): no API role may write the audit table.
create function private.audit_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into private.membership_audit (notebook_id, user_id, actor, op, new_role)
    values (new.notebook_id, new.user_id, (select auth.uid()), 'insert', new.role);
    return new;
  elsif tg_op = 'UPDATE' then
    insert into private.membership_audit (notebook_id, user_id, actor, op, old_role, new_role)
    values (new.notebook_id, new.user_id, (select auth.uid()), 'update', old.role, new.role);
    return new;
  else
    insert into private.membership_audit (notebook_id, user_id, actor, op, old_role)
    values (old.notebook_id, old.user_id, (select auth.uid()), 'delete', old.role);
    return old;
  end if;
end;
$$;

revoke execute on function private.audit_membership() from public, anon, authenticated;

create trigger notebook_members_audit
  after insert or update or delete on public.notebook_members
  for each row execute function private.audit_membership();

-- SECURITY DEFINER (ADR 0001): as invoker, the lock below went through RLS. Mid-statement
-- (a bulk delete or demote by notebook_id), the acting owner is no longer an owner, the
-- notebook looked deleted and the last owner could go. As definer, "not found" only
-- means the notebook row is really gone (the cascade from deleting it).
create function private.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- The notebook is gone: this is the cascade from deleting it, so let it through.
  -- Otherwise lock it, so two owners cannot demote each other at the same time.
  -- NO KEY UPDATE does not conflict with the KEY SHARE locks of foreign key checks.
  perform 1 from public.notebooks n where n.id = old.notebook_id for no key update;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if not exists (
    select 1
    from public.notebook_members m
    where m.notebook_id = old.notebook_id
      and m.role = 'owner'
      and m.user_id <> old.user_id
  ) then
    raise exception 'notebook must keep at least one owner' using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function private.guard_last_owner() from public, anon, authenticated;

create trigger notebook_members_guard_last_owner
  before update or delete on public.notebook_members
  for each row execute function private.guard_last_owner();
