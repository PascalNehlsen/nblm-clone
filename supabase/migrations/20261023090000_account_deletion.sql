-- Account deletion (ADR 0021). The app deletes a user's sole-owned notebooks with the user's
-- own client, then the auth user with the admin API; foreign keys cascade memberships,
-- messages and citations and null usage.user_id. private.membership_audit has no foreign key
-- (it must outlive the rows it describes), so the ids of deleted users are forgotten here,
-- every 15 minutes, for every deleted user, also after a partial failure. Expand only.

create function private.forget_deleted_users_in_audit()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update private.membership_audit a
     set user_id = case when a.user_id is not null and not exists (select 1 from auth.users u where u.id = a.user_id) then null else a.user_id end,
         actor   = case when a.actor   is not null and not exists (select 1 from auth.users u where u.id = a.actor)   then null else a.actor   end
   where (a.user_id is not null and not exists (select 1 from auth.users u where u.id = a.user_id))
      or (a.actor   is not null and not exists (select 1 from auth.users u where u.id = a.actor));
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke execute on function private.forget_deleted_users_in_audit() from public, anon, authenticated;

select cron.schedule('nblm-forget-deleted-users', '*/15 * * * *', 'select private.forget_deleted_users_in_audit()');
