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

-- ----------------------------------------------------------------- relay ---
-- A phone away from the office talks to its PC through here while the PC is
-- on: the phone writes a call (method + API path), the PC answers it within a
-- second or two. Live run tabs (captchas), chat, everything — no Tailscale.
create table if not exists public.keep_calls (
  id          bigserial primary key,
  agency_id   uuid not null,
  device_id   uuid not null default auth.uid(),
  method      text not null,
  path        text not null,
  body        jsonb,
  created_at  timestamptz not null default now(),
  status      text not null default 'new',     -- new · done · late
  answer      jsonb,
  answer_bin  text,                            -- base64 (pictures, PDFs)
  answer_type text,
  answer_head jsonb,
  answer_code int,
  answered_at timestamptz
);
create index if not exists keep_calls_new on public.keep_calls (agency_id, status, id);
alter table public.keep_calls enable row level security;
drop policy if exists keep_calls_add on public.keep_calls;
create policy keep_calls_add on public.keep_calls for insert
  with check (agency_id = public.keep_agency() and device_id = auth.uid());
drop policy if exists keep_calls_read on public.keep_calls;
create policy keep_calls_read on public.keep_calls for select
  using (device_id = auth.uid() or agency_id = auth.uid());
drop policy if exists keep_calls_answer on public.keep_calls;
create policy keep_calls_answer on public.keep_calls for update
  using (agency_id = auth.uid()) with check (agency_id = auth.uid());
drop policy if exists keep_calls_clean on public.keep_calls;
create policy keep_calls_clean on public.keep_calls for delete using (agency_id = auth.uid());

-- ------------------------------------------------- files, pairing, live ---
-- Each agency's secrets: the key its documents are encrypted with before
-- they go to Telegram (Supabase keeps no files), and the name of its live
-- channel (phones ↔ PC, instant). Only the agency's PC and phones read them.
create table if not exists public.keep_secrets (
  agency_id  uuid primary key references auth.users on delete cascade,
  file_key   text not null,                 -- base64, AES-256-GCM
  live       text not null,                 -- random channel name part
  created_at timestamptz not null default now()
);
alter table public.keep_secrets add column if not exists bot text;   -- the storage bot (phones download with it)
alter table public.keep_secrets enable row level security;
drop policy if exists keep_secrets_read on public.keep_secrets;
create policy keep_secrets_read on public.keep_secrets for select using (agency_id = public.keep_agency());
drop policy if exists keep_secrets_write on public.keep_secrets;
create policy keep_secrets_write on public.keep_secrets for all using (agency_id = auth.uid()) with check (agency_id = auth.uid());

-- Pairing from anywhere: PC number + the agency's phone password (set on
-- the main PC). Only a hash is kept; 10 wrong tries lock it for an hour.
create table if not exists public.keep_pairing (
  pc_number   text primary key,
  agency_id   uuid not null references auth.users on delete cascade,
  pass_hash   text not null,
  fails       int not null default 0,
  fail_since  timestamptz,
  updated_at  timestamptz not null default now()
);
alter table public.keep_pairing enable row level security;
drop policy if exists keep_pairing_owner on public.keep_pairing;
create policy keep_pairing_owner on public.keep_pairing for select using (agency_id = auth.uid());

create or replace function public.keep_set_phone_password(p_pc text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from keep_devices where user_id = auth.uid()) then raise exception 'phones cannot do this'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'use at least 6 characters'; end if;
  delete from keep_pairing where agency_id = auth.uid() and pc_number <> p_pc;
  insert into keep_pairing (pc_number, agency_id, pass_hash, fails, fail_since, updated_at)
    values (p_pc, auth.uid(), crypt(p_password, gen_salt('bf')), 0, null, now())
    on conflict (pc_number) do update set agency_id = excluded.agency_id, pass_hash = excluded.pass_hash, fails = 0, fail_since = null, updated_at = now()
    where keep_pairing.agency_id = auth.uid();
end $$;

-- A new phone (signed in with its own new account) joins the agency.
create or replace function public.keep_join(p_pc text, p_password text, p_name text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r keep_pairing;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from keep_pairing where pc_number = p_pc;
  if r is null then raise exception 'No Adal Keep with that PC number has phones turned on.'; end if;
  if r.fails >= 10 and r.fail_since > now() - interval '1 hour' then raise exception 'Too many wrong passwords — try again in an hour.'; end if;
  if r.pass_hash <> crypt(coalesce(p_password, ''), r.pass_hash) then
    update keep_pairing set fails = case when fail_since > now() - interval '1 hour' then fails + 1 else 1 end,
      fail_since = case when fail_since > now() - interval '1 hour' then fail_since else now() end where pc_number = p_pc;
    raise exception 'Wrong password.';
  end if;
  insert into keep_devices (user_id, agency_id, name) values (auth.uid(), r.agency_id, left(coalesce(nullif(p_name, ''), 'Phone'), 60))
    on conflict (user_id) do update set agency_id = excluded.agency_id, name = excluded.name, revoked = false;
  update keep_pairing set fails = 0, fail_since = null where pc_number = p_pc;
  return r.agency_id;
end $$;
grant execute on function public.keep_join(text, text, text) to authenticated;
grant execute on function public.keep_set_phone_password(text, text) to authenticated;
-- The PC may leave a big live answer for a phone in keep_calls.
drop policy if exists keep_calls_owner_add on public.keep_calls;
create policy keep_calls_owner_add on public.keep_calls for insert with check (agency_id = auth.uid());

-- --------------------------------------- pairing: PC number + "Yes, it's me" ---
-- The main PC publishes its 5-digit number. A phone types it and asks to
-- join; the PC shows "Phone X wants to join — Yes, it's me / No"; Yes lets
-- it in and the phone goes on by itself. 5 wrong numbers lock a phone an hour.
alter table public.keep_pairing alter column pass_hash drop not null;
alter table public.keep_pairing add column if not exists open boolean not null default false;
create table if not exists public.keep_join_tries (
  user_id uuid primary key references auth.users on delete cascade,
  n int not null default 0,
  since timestamptz not null default now()
);
alter table public.keep_join_tries enable row level security;

create table if not exists public.keep_join_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,  -- the phone
  agency_id  uuid not null references auth.users on delete cascade,
  name       text,
  status     text not null default 'pending',          -- pending · approved · denied
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists keep_join_requests_open on public.keep_join_requests (agency_id, status);
alter table public.keep_join_requests enable row level security;
drop policy if exists keep_join_requests_read on public.keep_join_requests;
create policy keep_join_requests_read on public.keep_join_requests for select using (user_id = auth.uid() or agency_id = auth.uid());

create or replace function public.keep_publish_pc(p_pc text, p_open boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from keep_devices where user_id = auth.uid()) then raise exception 'phones cannot do this'; end if;
  delete from keep_pairing where agency_id = auth.uid() and pc_number <> p_pc;
  insert into keep_pairing (pc_number, agency_id, open, updated_at) values (p_pc, auth.uid(), false, now())
    on conflict (pc_number) do update set updated_at = now() where keep_pairing.agency_id = auth.uid();
end $$;
grant execute on function public.keep_publish_pc(text, boolean) to authenticated;

-- The phone asks to join (the PC number only); returns the request id.
create or replace function public.keep_request_join(p_pc text, p_name text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r keep_pairing; t keep_join_tries; rid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into t from keep_join_tries where user_id = auth.uid();
  if t.n >= 5 and t.since > now() - interval '1 hour' then raise exception 'Too many wrong numbers — try again in an hour.'; end if;
  select * into r from keep_pairing where pc_number = p_pc;
  if r is null then
    insert into keep_join_tries (user_id, n, since) values (auth.uid(), 1, now())
      on conflict (user_id) do update set n = case when keep_join_tries.since > now() - interval '1 hour' then keep_join_tries.n + 1 else 1 end,
        since = case when keep_join_tries.since > now() - interval '1 hour' then keep_join_tries.since else now() end;
    raise exception 'No Adal Keep has that PC number. Check it on the main PC (Settings → Main PC).';
  end if;
  update keep_join_requests set status = 'denied', decided_at = now() where user_id = auth.uid() and status = 'pending';
  insert into keep_join_requests (user_id, agency_id, name) values (auth.uid(), r.agency_id, left(coalesce(nullif(p_name, ''), 'Phone'), 60)) returning id into rid;
  return rid;
end $$;
grant execute on function public.keep_request_join(text, text) to authenticated;

-- The PC answers: Yes lets the phone in.
create or replace function public.keep_answer_join(p_id uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare q keep_join_requests;
begin
  select * into q from keep_join_requests where id = p_id and agency_id = auth.uid() and status = 'pending';
  if q is null then raise exception 'That request is gone.'; end if;
  update keep_join_requests set status = case when p_ok then 'approved' else 'denied' end, decided_at = now() where id = p_id;
  if p_ok then
    insert into keep_devices (user_id, agency_id, name) values (q.user_id, q.agency_id, q.name)
      on conflict (user_id) do update set agency_id = excluded.agency_id, name = excluded.name, revoked = false;
  end if;
end $$;
grant execute on function public.keep_answer_join(uuid, boolean) to authenticated;

-- Number-only joining without the PC's Yes is closed.
update public.keep_pairing set open = false;
