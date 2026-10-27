-- ===========================================================================
-- Adal Keep online copy — run this once in Supabase: Dashboard → SQL Editor →
-- New query → paste → Run. Safe to run again (it only adds what is missing).
-- Run schema.sql (the chat) first.
--
-- Every Adal Keep main PC is one agency (its Supabase Auth user, the same as
-- for the chat). The PC keeps an online copy of its profiles, documents, runs
-- and tasks here, so the agency's phones can work when the PC is off.
-- A phone is a Supabase user of its own, made by the PC when the phone pairs
-- on the office Wi-Fi (keep_devices). It sees ONLY its agency's data, and the
-- agency can remove it at any time (revoked). Phones never write the copy
-- itself: they write requests (keep_changes) that the PC applies.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables ---
create table if not exists public.keep_devices (
  user_id    uuid primary key references auth.users on delete cascade,  -- the phone
  agency_id  uuid not null references auth.users on delete cascade,     -- its PC
  name       text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz,
  revoked    boolean not null default false
);

create table if not exists public.keep_profiles (
  agency_id  uuid not null references auth.users on delete cascade,
  id         bigint not null,                -- the profile's id on the PC
  data       jsonb not null,                 -- the whole profile row
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false,
  primary key (agency_id, id)
);

create table if not exists public.keep_files (
  agency_id  uuid not null references auth.users on delete cascade,
  id         bigint not null,                -- the file's id on the PC
  profile_id bigint not null,
  field      text not null,                  -- Passport, Photo, Medical Report …
  name       text,
  mimetype   text,
  size       bigint,
  object     text,                           -- path in the "keep" bucket
  created_at timestamptz,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false,
  primary key (agency_id, id)
);
create index if not exists keep_files_profile on public.keep_files (agency_id, profile_id);

-- Runs (their last state, for the AI action cards) and tasks/calls.
create table if not exists public.keep_runs (
  agency_id  uuid not null references auth.users on delete cascade,
  id         bigint not null,
  profile_id bigint,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (agency_id, id)
);
create table if not exists public.keep_tasks (
  agency_id  uuid not null references auth.users on delete cascade,
  id         bigint not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (agency_id, id)
);

-- Everything else the pages need (brokers, employees, settings, workflows …): key → JSON.
create table if not exists public.keep_meta (
  agency_id  uuid not null references auth.users on delete cascade,
  key        text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (agency_id, key)
);

-- What phones asked while the PC was off; the PC applies them in order.
create table if not exists public.keep_changes (
  id         bigserial primary key,
  agency_id  uuid not null,
  device_id  uuid not null default auth.uid(),
  kind       text not null,                  -- profile_update · profile_create · file_add · run_start · task_update
  profile_id bigint,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  result     text
);
create index if not exists keep_changes_open on public.keep_changes (agency_id, applied_at, id);

-- --------------------------------------------------------------- helpers ---
-- The agency the signed-in user works for: a phone → its PC; a PC → itself.
create or replace function public.keep_agency() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select agency_id from keep_devices where user_id = auth.uid() and not revoked),
    case when exists (select 1 from keep_devices where user_id = auth.uid()) then null else auth.uid() end
  )
$$;

-- ----------------------------------------------------------------- rules ---
alter table public.keep_devices  enable row level security;
alter table public.keep_profiles enable row level security;
alter table public.keep_files    enable row level security;
alter table public.keep_runs     enable row level security;
alter table public.keep_tasks    enable row level security;
alter table public.keep_meta     enable row level security;
alter table public.keep_changes  enable row level security;

-- Phones: the PC adds and removes them; a phone sees its own row.
drop policy if exists keep_devices_owner on public.keep_devices;
create policy keep_devices_owner on public.keep_devices for all
  using (agency_id = auth.uid()) with check (agency_id = auth.uid());
drop policy if exists keep_devices_self on public.keep_devices;
create policy keep_devices_self on public.keep_devices for select using (user_id = auth.uid());

-- The copy: the agency's PC writes it, the agency's phones read it.
do $$
declare t text;
begin
  foreach t in array array['keep_profiles', 'keep_files', 'keep_runs', 'keep_tasks', 'keep_meta'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (agency_id = public.keep_agency())', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (agency_id = auth.uid()) with check (agency_id = auth.uid())', t || '_write', t);
  end loop;
end $$;

-- Requests: phones (and the PC) add them for their agency; the PC marks them done.
drop policy if exists keep_changes_add on public.keep_changes;
create policy keep_changes_add on public.keep_changes for insert
  with check (agency_id = public.keep_agency() and device_id = auth.uid());
drop policy if exists keep_changes_read on public.keep_changes;
create policy keep_changes_read on public.keep_changes for select using (agency_id = public.keep_agency());
drop policy if exists keep_changes_apply on public.keep_changes;
create policy keep_changes_apply on public.keep_changes for update
  using (agency_id = auth.uid()) with check (agency_id = auth.uid());

-- --------------------------------------------------------------- storage ---
-- Documents: keep/<agency id>/… — private; the agency's PC and phones only.
insert into storage.buckets (id, name, public) values ('keep', 'keep', false)
  on conflict (id) do nothing;

drop policy if exists keep_docs_read on storage.objects;
create policy keep_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'keep' and (storage.foldername(name))[1] = public.keep_agency()::text);
drop policy if exists keep_docs_add on storage.objects;
create policy keep_docs_add on storage.objects for insert to authenticated
  with check (bucket_id = 'keep' and (storage.foldername(name))[1] = public.keep_agency()::text);
drop policy if exists keep_docs_change on storage.objects;
create policy keep_docs_change on storage.objects for update to authenticated
  using (bucket_id = 'keep' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists keep_docs_remove on storage.objects;
create policy keep_docs_remove on storage.objects for delete to authenticated
  using (bucket_id = 'keep' and (storage.foldername(name))[1] = auth.uid()::text);
