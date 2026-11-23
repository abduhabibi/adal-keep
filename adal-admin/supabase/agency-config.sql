-- ===========================================================================
-- Adal Keep — one settings record per agency, and the first-run sign-ups.
-- Run once in the Supabase SQL Editor (after schema.sql and keep-sync.sql).
--
--   agency_config   what Adal sets for an agency in Adal Keep Admin (CV
--                   templates, agency e-mail, EPRO signature, LMIS SMS number,
--                   staff roles, feature switches, licence summary). Every PC
--                   of the agency reads it; only Adal (the service key) writes.
--   agency_signups  an agency that typed its name, phone and e-mail on the
--                   first run. Starts "new"; only Adal moves it to "setup" and
--                   "ready" (the agency cannot mark itself ready).
-- ===========================================================================

create table if not exists public.agency_config (
  agency_id   uuid primary key references auth.users on delete cascade,
  config      jsonb not null default '{}'::jsonb,
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);
alter table public.agency_config enable row level security;
drop policy if exists agency_config_read on public.agency_config;
create policy agency_config_read on public.agency_config for select using (agency_id = public.keep_agency());
-- (no insert / update / delete rule: the admin panel's service key does that)

create table if not exists public.agency_signups (
  agency_id   uuid primary key references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  phone       text not null check (char_length(phone) between 5 and 30),
  email       text not null check (char_length(email) between 5 and 160),
  pc_number   text,
  status      text not null default 'new' check (status in ('new', 'setup', 'ready')),
  note        text,
  created_at  timestamptz not null default now(),
  ready_at    timestamptz
);
alter table public.agency_signups enable row level security;
drop policy if exists agency_signups_read on public.agency_signups;
create policy agency_signups_read on public.agency_signups for select using (agency_id = public.keep_agency());

-- The agency's PC signs up (or corrects its details) — never touches the status.
create or replace function public.agency_sign_up(p_name text, p_phone text, p_email text, p_pc text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into agency_signups (agency_id, name, phone, email, pc_number)
  values (auth.uid(), left(trim(p_name), 120), left(trim(p_phone), 30), left(trim(p_email), 160), p_pc)
  on conflict (agency_id) do update
    set name = excluded.name, phone = excluded.phone, email = excluded.email, pc_number = excluded.pc_number;
end $$;
grant execute on function public.agency_sign_up(text, text, text, text) to authenticated;

-- The EPRO signature file Adal uploads for an agency: private bucket, the
-- agency's PCs read only their own folder (<agency id>/…); Adal writes with the service key.
insert into storage.buckets (id, name, public) values ('agency-config', 'agency-config', false) on conflict (id) do nothing;
drop policy if exists agency_config_files_read on storage.objects;
create policy agency_config_files_read on storage.objects for select to authenticated
  using (bucket_id = 'agency-config' and (storage.foldername(name))[1] = public.keep_agency()::text);

-- Download codes for the website (adalkeep.pages.dev): the installer holds the
-- licence key, so a download needs a code Adal made in Admin → Setup. Only the
-- website's function (service key) reads this table; nobody else has a rule.
create table if not exists public.install_codes (
  code        text primary key,
  note        text,
  expires_at  timestamptz not null,
  max_uses    integer not null default 3,
  uses        integer not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.install_codes enable row level security;
