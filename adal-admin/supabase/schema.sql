-- ===========================================================================
-- Adal Keep chat — run this once in Supabase: Dashboard → SQL Editor → New
-- query → paste → Run. Safe to run again (it only adds what is missing).
--
-- Every Adal Keep installation is one "agency" (a Supabase Auth user). It can
--   * read the list of agencies (name, last seen — not their PC numbers),
--   * talk in the "Everyone" group, in private chats with any agency, and in
--     its own inbox with Adal (the admin),
--   * send its payment receipt to Adal (unlock request).
-- What it may read or write is decided here, in the database, so a changed
-- copy of Adal Keep cannot read other agencies' chats or post as someone else.
-- The admin panel (adal-admin) uses the service key and is not limited.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables ---
create table if not exists public.agencies (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  pc_number   text,
  banned      boolean not null default false,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('group', 'direct', 'admin')),
  key              text not null unique,  -- 'everyone' | 'dm:<a>:<b>' | 'admin:<agency>'
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now()
);

create table if not exists public.members (
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  agency_id        uuid not null references public.agencies (id) on delete cascade,
  last_read_id     bigint not null default 0,
  primary key (conversation_id, agency_id)
);

create table if not exists public.messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  sender_id        uuid not null default auth.uid() references public.agencies (id) on delete cascade,
  body             text check (char_length(body) <= 4000),
  image_path       text,
  created_at       timestamptz not null default now(),
  check (coalesce(btrim(body), '') <> '' or image_path is not null)
);
create index if not exists messages_conv_id on public.messages (conversation_id, id);

create table if not exists public.unlock_requests (
  id          bigint generated always as identity primary key,
  agency_id   uuid not null default auth.uid() references public.agencies (id) on delete cascade,
  pc_number   text not null check (pc_number ~ '^[0-9]{6}$'),
  image_path  text not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note        text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

-- ------------------------------------------------------------- helpers ----
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from agencies where id = auth.uid() and is_admin)
$$;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from agencies where id = auth.uid() and banned)
$$;

create or replace function public.is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where conversation_id = conv and agency_id = auth.uid())
$$;

-- Links are not allowed in messages (like the agency asked: "not links").
create or replace function public.has_link(t text) returns boolean
language sql immutable as $$
  select coalesce(t, '') ~* '(https?://|www\.|t\.me/|wa\.me/|[a-z0-9-]+\.(com|net|org|io|me|et|sa|ae|kw|qa|info|biz|co|app|link|xyz|ly|gl|site|online|shop)(/|\s|$))'
$$;

-- An installation joins (or renames itself): its agency row, the Everyone
-- group and its inbox with Adal.
create or replace function public.join_agency(p_name text, p_pc text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); conv uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  insert into agencies (id, name, pc_number) values (me, btrim(p_name), p_pc)
    on conflict (id) do update set name = btrim(excluded.name), pc_number = excluded.pc_number, last_seen = now();

  insert into conversations (kind, key) values ('group', 'everyone') on conflict (key) do nothing;
  select id into conv from conversations where key = 'everyone';
  insert into members (conversation_id, agency_id) values (conv, me) on conflict do nothing;

  insert into conversations (kind, key) values ('admin', 'admin:' || me) on conflict (key) do nothing;
  select id into conv from conversations where key = 'admin:' || me;
  insert into members (conversation_id, agency_id) values (conv, me) on conflict do nothing;
  insert into members (conversation_id, agency_id)
    select conv, id from agencies where is_admin on conflict do nothing;
  return me;
end $$;

-- The private chat between me and another agency (made the first time).
create or replace function public.open_direct(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); k text; conv uuid;
begin
  if me is null or other is null or other = me then raise exception 'bad chat'; end if;
  if not exists (select 1 from agencies where id = other) then raise exception 'no such agency'; end if;
  k := 'dm:' || least(me::text, other::text) || ':' || greatest(me::text, other::text);
  insert into conversations (kind, key) values ('direct', k) on conflict (key) do nothing;
  select id into conv from conversations where key = k;
  insert into members (conversation_id, agency_id) values (conv, me), (conv, other) on conflict do nothing;
  return conv;
end $$;

-- The agency list everyone sees: names, never PC numbers.
create or replace function public.list_agencies()
returns table (id uuid, name text, last_seen timestamptz, is_admin boolean, banned boolean)
language sql stable security definer set search_path = public as $$
  select id, name, last_seen, is_admin, banned from agencies order by is_admin desc, name
$$;

-- My conversations with the other side's name and my unread count.
create or replace function public.my_conversations()
returns table (id uuid, kind text, title text, other_id uuid, last_message_at timestamptz,
               last_body text, last_has_image boolean, unread bigint)
language sql stable security definer set search_path = public as $$
  select c.id, c.kind,
         case c.kind when 'group' then 'Everyone'
                     when 'admin' then case when exists (select 1 from agencies where id = auth.uid() and is_admin)
                                            then (select a.name from agencies a where 'admin:' || a.id = c.key)
                                            else 'Adal Keep' end
                     else (select a.name from members m2 join agencies a on a.id = m2.agency_id
                           where m2.conversation_id = c.id and m2.agency_id <> auth.uid() limit 1) end,
         case c.kind when 'direct' then (select m2.agency_id from members m2
                                         where m2.conversation_id = c.id and m2.agency_id <> auth.uid() limit 1) end,
         c.last_message_at,
         (select left(body, 120) from messages where conversation_id = c.id order by id desc limit 1),
         coalesce((select image_path is not null from messages where conversation_id = c.id order by id desc limit 1), false),
         (select count(*) from messages x where x.conversation_id = c.id and x.id > m.last_read_id and x.sender_id <> auth.uid())
  from members m join conversations c on c.id = m.conversation_id
  where m.agency_id = auth.uid()
  order by c.last_message_at desc
$$;

-- Messages bump their conversation to the top.
create or replace function public.touch_conversation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  update agencies set last_seen = now() where id = new.sender_id;
  return new;
end $$;
drop trigger if exists messages_touch on public.messages;
create trigger messages_touch after insert on public.messages
  for each row execute function public.touch_conversation();

-- ---------------------------------------------------------------- rules ---
alter table public.agencies        enable row level security;
alter table public.conversations   enable row level security;
alter table public.members         enable row level security;
alter table public.messages        enable row level security;
alter table public.unlock_requests enable row level security;

drop policy if exists agencies_self on public.agencies;
create policy agencies_self on public.agencies for select using (id = auth.uid() or public.is_admin());

drop policy if exists conversations_member on public.conversations;
create policy conversations_member on public.conversations for select using (public.is_member(id) or public.is_admin());

drop policy if exists members_read on public.members;
create policy members_read on public.members for select using (public.is_member(conversation_id) or public.is_admin());
drop policy if exists members_mark_read on public.members;
create policy members_mark_read on public.members for update using (agency_id = auth.uid()) with check (agency_id = auth.uid());

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select using (public.is_member(conversation_id) or public.is_admin());
drop policy if exists messages_send on public.messages;
create policy messages_send on public.messages for insert with check (
  sender_id = auth.uid()
  and public.is_member(conversation_id)
  and not public.has_link(body)
  -- A banned agency is out of the Everyone group and private chats; its
  -- inbox with Adal stays open so it can still ask why.
  and (not public.is_banned()
       or exists (select 1 from public.conversations c where c.id = conversation_id and c.kind = 'admin'))
);

drop policy if exists unlock_own on public.unlock_requests;
create policy unlock_own on public.unlock_requests for select using (agency_id = auth.uid() or public.is_admin());
drop policy if exists unlock_send on public.unlock_requests;
create policy unlock_send on public.unlock_requests for insert with check (agency_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select on public.agencies, public.conversations, public.members, public.messages, public.unlock_requests to authenticated;
grant update (last_read_id) on public.members to authenticated;
grant insert (conversation_id, body, image_path) on public.messages to authenticated;
grant insert (pc_number, image_path) on public.unlock_requests to authenticated;
grant execute on function public.join_agency(text, text), public.open_direct(uuid), public.list_agencies(),
  public.my_conversations(), public.is_admin(), public.is_banned(), public.is_member(uuid), public.has_link(text)
  to authenticated;

-- ------------------------------------------------------- picture storage ---
-- Pictures sent in chat and payment receipts: a private bucket. An agency
-- uploads only into its own folder (<agency id>/...); signed-in agencies can
-- read them (file names are random).
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('chat', 'chat', false) on conflict (id) do nothing;
    drop policy if exists chat_upload on storage.objects;
    create policy chat_upload on storage.objects for insert to authenticated
      with check (bucket_id = 'chat' and (storage.foldername(name))[1] = auth.uid()::text);
    drop policy if exists chat_read on storage.objects;
    create policy chat_read on storage.objects for select to authenticated using (bucket_id = 'chat');
  end if;
end $$;
