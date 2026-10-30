-- ===========================================================================
-- Adal Keep updates from Supabase (so the GitHub repository can be private).
-- Run once in Supabase → SQL Editor (after schema.sql and keep-sync.sql).
--
--   adal-updates (private bucket)
--     release/latest.json        the newest version + Adal's signature
--     release/<sha>.tar.gz       the version itself (app code, frontend built)
--     phone/version.json         the newest phone app
--     phone/AdalKeep.apk
--
-- Only Adal writes (adal-keep-backend/scripts/publish-update.mjs, with the
-- service key). Agency PCs that are not blocked and their paired phones read.
-- Every PC checks Adal's signature before it installs anything, so even a
-- changed file in storage could never reach an agency.
-- ===========================================================================
insert into storage.buckets (id, name, public) values ('adal-updates', 'adal-updates', false)
on conflict (id) do nothing;

create or replace function public.can_get_updates() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from agencies where id = auth.uid() and not banned)
      or exists (select 1 from keep_devices d join agencies a on a.id = d.agency_id
                 where d.user_id = auth.uid() and not d.revoked and not a.banned)
$$;
grant execute on function public.can_get_updates() to authenticated;

drop policy if exists adal_updates_read on storage.objects;
create policy adal_updates_read on storage.objects for select to authenticated
  using (bucket_id = 'adal-updates' and public.can_get_updates());
