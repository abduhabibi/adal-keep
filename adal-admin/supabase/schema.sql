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

-- Agencies Adal adds by PC number (before or after they install): the name
-- they appear under, and whether they paid (then that PC unlocks itself).
-- Only the admin panel (service key) reads or writes this table.
create table if not exists public.agency_invites (
  pc_number   text primary key check (pc_number ~ '^[0-9]{6}$'),
  name        text not null check (char_length(name) between 1 and 120),
  paid        boolean not null default false,
  created_at  timestamptz not null default now()
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
  -- Added by Adal with this PC number: that name wins.
  select coalesce((select name from agency_invites where pc_number = p_pc), btrim(p_name)) into p_name;
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

-- Adal marked this PC (by its number) as paid in the admin panel.
create or replace function public.my_invite_paid() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from agency_invites i join agencies a on a.pc_number = i.pc_number
                 where a.id = auth.uid() and i.paid)
$$;

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
alter table public.agency_invites  enable row level security;  -- no rules: only the admin panel

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
  public.my_invite_paid(), public.is_admin(), public.is_banned(), public.is_member(uuid), public.has_link(text)
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

-- ===========================================================================
-- v2 — chat like Telegram: own groups with members and admins, reply, edit,
-- delete, forward, pin, files and voice notes, seen ticks, online / last
-- seen, typing. Safe to run again.
-- ===========================================================================
alter table public.conversations add column if not exists title text check (char_length(title) <= 80);
alter table public.conversations add column if not exists created_by uuid references public.agencies (id) on delete set null;
alter table public.conversations add column if not exists pinned_message_id bigint;
alter table public.members add column if not exists role text not null default 'member';
do $$ begin
  alter table public.members add constraint members_role_check check (role in ('owner', 'admin', 'member'));
exception when duplicate_object then null; end $$;

alter table public.messages add column if not exists reply_to bigint references public.messages (id) on delete set null;
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;
alter table public.messages add column if not exists updated_at timestamptz not null default now();
alter table public.messages add column if not exists forwarded_from text check (char_length(forwarded_from) <= 120);
alter table public.messages add column if not exists kind text not null default 'text';
alter table public.messages add column if not exists file_path text;
alter table public.messages add column if not exists file_name text check (char_length(file_name) <= 200);
alter table public.messages add column if not exists file_mime text;
alter table public.messages add column if not exists file_size bigint;
do $$ begin
  alter table public.messages add constraint messages_kind_check check (kind in ('text', 'image', 'file', 'voice'));
exception when duplicate_object then null; end $$;
-- A message has text, a picture or a file — or was deleted.
alter table public.messages drop constraint if exists messages_check;
do $$ begin
  alter table public.messages add constraint messages_has_content check (
    deleted_at is not null or coalesce(btrim(body), '') <> '' or image_path is not null or file_path is not null);
exception when duplicate_object then null; end $$;
create index if not exists messages_updated on public.messages (conversation_id, updated_at);

create table if not exists public.typing (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  agency_id       uuid not null references public.agencies (id) on delete cascade,
  at              timestamptz not null default now(),
  primary key (conversation_id, agency_id)
);
alter table public.typing enable row level security;  -- only through the functions below

-- ------------------------------------------------------------- helpers v2 --
create or replace function public.my_role(conv uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from members where conversation_id = conv and agency_id = auth.uid()
$$;

create or replace function public.can_manage(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from conversations c where c.id = conv and c.key like 'grp:%')
     and coalesce(public.my_role(conv) in ('owner', 'admin'), false)
$$;

-- Online: the chat page says hello every 30 s.
create or replace function public.ping() returns void
language sql security definer set search_path = public as $$
  update agencies set last_seen = now() where id = auth.uid()
$$;

-- Groups -------------------------------------------------------------------
create or replace function public.create_group(p_title text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); conv uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned() then raise exception 'blocked by Adal'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'the group needs a name'; end if;
  insert into conversations (kind, key, title, created_by)
    values ('group', 'grp:' || gen_random_uuid(), btrim(p_title), me) returning id into conv;
  insert into members (conversation_id, agency_id, role) values (conv, me, 'owner');
  insert into members (conversation_id, agency_id)
    select conv, a.id from agencies a where a.id = any (coalesce(p_members, '{}')) and a.id <> me
    on conflict do nothing;
  return conv;
end $$;

create or replace function public.add_group_members(conv uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(conv) then raise exception 'only the group''s admins add members'; end if;
  insert into members (conversation_id, agency_id)
    select conv, a.id from agencies a where a.id = any (coalesce(p_members, '{}')) on conflict do nothing;
end $$;

-- Remove someone (admins), or leave (anyone). A leaving owner hands over.
create or replace function public.remove_group_member(conv uuid, who uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); was text;
begin
  if not exists (select 1 from conversations where id = conv and key like 'grp:%') then raise exception 'not a group'; end if;
  if who <> me and not public.can_manage(conv) then raise exception 'only the group''s admins remove members'; end if;
  select role into was from members where conversation_id = conv and agency_id = who;
  if was = 'owner' and who <> me then raise exception 'the owner can only leave'; end if;
  delete from members where conversation_id = conv and agency_id = who;
  if was = 'owner' then
    update members set role = 'owner' where conversation_id = conv and agency_id = (
      select agency_id from members where conversation_id = conv order by (role = 'admin') desc limit 1);
  end if;
end $$;

create or replace function public.set_group_admin(conv uuid, who uuid, make_admin boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(public.my_role(conv), '') <> 'owner' then raise exception 'only the owner chooses admins'; end if;
  update members set role = case when make_admin then 'admin' else 'member' end
    where conversation_id = conv and agency_id = who and role <> 'owner';
end $$;

create or replace function public.rename_group(conv uuid, p_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(conv) then raise exception 'only the group''s admins rename it'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'the group needs a name'; end if;
  update conversations set title = btrim(p_title) where id = conv;
end $$;

create or replace function public.group_members(conv uuid)
returns table (agency_id uuid, name text, role text, last_seen timestamptz, last_read_id bigint)
language sql stable security definer set search_path = public as $$
  select m.agency_id, a.name, m.role, a.last_seen, m.last_read_id
  from members m join agencies a on a.id = m.agency_id
  where m.conversation_id = conv and (public.is_member(conv) or public.is_admin())
  order by (m.role = 'owner') desc, (m.role = 'admin') desc, a.name
$$;

-- Messages -----------------------------------------------------------------
create or replace function public.edit_message(msg bigint, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.has_link(p_body) then raise exception 'links are not allowed'; end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'empty message'; end if;
  update messages set body = btrim(p_body), edited_at = now(), updated_at = now()
    where id = msg and sender_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'only your own messages can be edited'; end if;
end $$;

-- Delete for everyone: your own message, or any message in a group you manage.
create or replace function public.delete_message(msg bigint)
returns void language plpgsql security definer set search_path = public as $$
declare conv uuid; who uuid;
begin
  select conversation_id, sender_id into conv, who from messages where id = msg;
  if conv is null then return; end if;
  if who <> auth.uid() and not public.can_manage(conv) and not public.is_admin() then
    raise exception 'you can only delete your own messages';
  end if;
  update messages set body = null, image_path = null, file_path = null, file_name = null,
         deleted_at = now(), updated_at = now() where id = msg;
end $$;

-- Pin (or unpin with null): private chats either side; groups their admins; Everyone only Adal.
create or replace function public.pin_message(conv uuid, msg bigint)
returns void language plpgsql security definer set search_path = public as $$
declare k text;
begin
  select key into k from conversations where id = conv;
  if not public.is_member(conv) and not public.is_admin() then raise exception 'not in this chat'; end if;
  if k = 'everyone' and not public.is_admin() then raise exception 'only Adal pins in Everyone'; end if;
  if k like 'grp:%' and not public.can_manage(conv) then raise exception 'only the group''s admins pin'; end if;
  if msg is not null and not exists (select 1 from messages where id = msg and conversation_id = conv) then raise exception 'no such message'; end if;
  update conversations set pinned_message_id = msg where id = conv;
end $$;

-- Typing… (6 seconds after the last key press)
create or replace function public.set_typing(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.is_member(conv) then
    insert into typing (conversation_id, agency_id, at) values (conv, auth.uid(), now())
      on conflict (conversation_id, agency_id) do update set at = now();
  end if;
end $$;

create or replace function public.typing_in(conv uuid) returns table (agency_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select t.agency_id, a.name from typing t join agencies a on a.id = t.agency_id
  where t.conversation_id = conv and t.agency_id <> auth.uid() and t.at > now() - interval '6 seconds'
    and public.is_member(conv)
$$;

-- My chats, v2: group names, my role, members, pin, last message kind.
drop function if exists public.my_conversations();
create or replace function public.my_conversations()
returns table (id uuid, kind text, title text, other_id uuid, last_message_at timestamptz,
               last_body text, last_has_image boolean, unread bigint,
               my_role text, member_count bigint, pinned_message_id bigint, last_kind text, other_last_seen timestamptz,
               is_everyone boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.kind,
         case when c.key = 'everyone' then 'Everyone'
              when c.key like 'grp:%' then c.title
              when c.kind = 'admin' then case when exists (select 1 from agencies where id = auth.uid() and is_admin)
                                              then (select a.name from agencies a where 'admin:' || a.id = c.key)
                                              else 'Adal Keep' end
              else (select a.name from members m2 join agencies a on a.id = m2.agency_id
                    where m2.conversation_id = c.id and m2.agency_id <> auth.uid() limit 1) end,
         case c.kind when 'direct' then (select m2.agency_id from members m2
                                         where m2.conversation_id = c.id and m2.agency_id <> auth.uid() limit 1) end,
         c.last_message_at,
         (select case when deleted_at is not null then 'Message deleted' else left(body, 120) end
            from messages where conversation_id = c.id order by id desc limit 1),
         coalesce((select image_path is not null from messages where conversation_id = c.id order by id desc limit 1), false),
         (select count(*) from messages x where x.conversation_id = c.id and x.id > m.last_read_id
            and x.sender_id <> auth.uid() and x.deleted_at is null),
         m.role,
         (select count(*) from members m3 where m3.conversation_id = c.id),
         c.pinned_message_id,
         (select kind from messages where conversation_id = c.id order by id desc limit 1),
         case c.kind when 'direct' then (select a.last_seen from members m2 join agencies a on a.id = m2.agency_id
                                         where m2.conversation_id = c.id and m2.agency_id <> auth.uid() limit 1) end,
         c.key = 'everyone'
  from members m join conversations c on c.id = m.conversation_id
  where m.agency_id = auth.uid()
  order by c.last_message_at desc
$$;

grant insert (conversation_id, body, image_path, reply_to, forwarded_from, kind, file_path, file_name, file_mime, file_size)
  on public.messages to authenticated;
grant execute on function public.my_role(uuid), public.can_manage(uuid), public.ping(),
  public.create_group(text, uuid[]), public.add_group_members(uuid, uuid[]), public.remove_group_member(uuid, uuid),
  public.set_group_admin(uuid, uuid, boolean), public.rename_group(uuid, text), public.group_members(uuid),
  public.edit_message(bigint, text), public.delete_message(bigint), public.pin_message(uuid, bigint),
  public.set_typing(uuid), public.typing_in(uuid), public.my_conversations() to authenticated;
