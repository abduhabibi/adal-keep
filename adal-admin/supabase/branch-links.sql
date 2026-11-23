-- ===========================================================================
-- Adal Keep — branches: two agencies link to each other with a 6-digit code.
-- Run once in the Supabase SQL Editor, after schema.sql and keep-sync.sql.
-- Safe to run again (it only adds or replaces what is its own).
--
-- No second password anywhere: every agency signs in with its own account.
--   1. Agency A (Settings → Branches) searches agencies by name — it sees only
--      their name and city — and presses Connect (keep_branch_ask).
--   2. Agency B sees "A wants to link as your branch" and presses "Yes, it is
--      me": B's PC is shown a 6-digit code (keep_branch_confirm). The code is
--      valid 10 minutes, works once, and only its hash is kept.
--   3. Someone from B tells A the code; A types it (keep_branch_verify). On a
--      match the two are linked both ways (keep_branch_links).
--   4. Linked: each one reads the other's profile summaries (name, passport
--      number, stage, status — never documents, never passwords) as long as
--      the other shares them (keep_branch_profiles). Either one can Unlink.
--
-- Rate limits: 10 Connects per agency per hour; 5 codes per request; 5 wrong
-- codes end the request (Connect again for a new one). Wrong tries are
-- answered with a result, not an error, so the count is really kept (an
-- error would roll the count back).
--
-- Who sees what (RLS): the requests table has no policy at all (only these
-- functions and Adal's service key touch it, so nobody can read a code hash);
-- a link row is visible only to its two agencies. Phones (keep_devices) can do
-- none of this. Adal Keep Admin reads everything with the service key.
-- ===========================================================================

create extension if not exists pgcrypto;

-- The city shown beside the name in the search (the agency types it in Settings → Branches).
alter table public.agencies add column if not exists city text check (city is null or char_length(city) <= 60);

create table if not exists public.keep_branch_requests (
  id           uuid primary key default gen_random_uuid(),
  from_agency  uuid not null references auth.users on delete cascade,   -- presses Connect, types the code
  to_agency    uuid not null references auth.users on delete cascade,   -- says "Yes, it is me", sees the code
  status       text not null default 'pending'
               check (status in ('pending', 'shown', 'linked', 'denied', 'expired', 'failed', 'cancelled')),
  code_hash    text,                                                   -- crypt() of the 6 digits; null when none is live
  code_until   timestamptz,                                            -- the code works until then (10 minutes)
  codes_made   int not null default 0,
  tries        int not null default 0,                                 -- wrong codes typed
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  check (from_agency <> to_agency)
);
create index if not exists keep_branch_requests_to on public.keep_branch_requests (to_agency, status);
create index if not exists keep_branch_requests_from on public.keep_branch_requests (from_agency, created_at);
alter table public.keep_branch_requests enable row level security;
-- (no policy on purpose: only the functions below and the service key)

create table if not exists public.keep_branch_links (
  agency_a    uuid not null references auth.users on delete cascade,    -- the smaller id of the two
  agency_b    uuid not null references auth.users on delete cascade,
  a_shares    boolean not null default true,                           -- A lets B read its profile summaries
  b_shares    boolean not null default true,
  asked_by    uuid,
  created_at  timestamptz not null default now(),
  primary key (agency_a, agency_b),
  check (agency_a < agency_b)
);
alter table public.keep_branch_links enable row level security;
drop policy if exists keep_branch_links_two on public.keep_branch_links;
create policy keep_branch_links_two on public.keep_branch_links for select
  using (auth.uid() = agency_a or auth.uid() = agency_b);
grant select on public.keep_branch_links to authenticated;

-- A PC of an agency (not a phone, not banned) is calling.
create or replace function public.keep_branch_caller() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from keep_devices where user_id = auth.uid()) then raise exception 'phones cannot link branches'; end if;
  if exists (select 1 from agencies where id = auth.uid() and banned) then raise exception 'this agency was blocked by Adal'; end if;
  return auth.uid();
end $$;

create or replace function public.keep_branch_linked(p_one uuid, p_two uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from keep_branch_links where agency_a = least(p_one, p_two) and agency_b = greatest(p_one, p_two))
$$;

create or replace function public.keep_set_city(p_city text) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  update agencies set city = nullif(left(btrim(coalesce(p_city, '')), 60), '') where id = me;
end $$;

-- Search by name: name and city only (never PC numbers, never anything else).
create or replace function public.keep_branch_search(p_q text)
returns table (id uuid, name text, city text, linked boolean)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := keep_branch_caller(); q text := btrim(coalesce(p_q, ''));
begin
  if char_length(q) < 2 then return; end if;
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select a.id, a.name, a.city, keep_branch_linked(me, a.id)
      from agencies a
     where a.id <> me and not a.banned and not a.is_admin
       and a.name ilike '%' || q || '%'
       and a.name not like '% · branch PC %'          -- an old follower PC's own account, not an agency
       and not exists (select 1 from keep_devices d where d.user_id = a.id)
     order by (a.name ilike q || '%') desc, a.name
     limit 20;
end $$;

-- Connect: ask that agency. Returns the request id.
create or replace function public.keep_branch_ask(p_to uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := keep_branch_caller(); rid uuid;
begin
  if p_to is null or p_to = me then raise exception 'Choose another agency.'; end if;
  if not exists (select 1 from agencies where id = p_to and not banned and not is_admin) then raise exception 'No such agency.'; end if;
  if keep_branch_linked(me, p_to) then raise exception 'Already linked.'; end if;
  if (select count(*) from keep_branch_requests where from_agency = me and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many Connects — try again in an hour.';
  end if;
  update keep_branch_requests set status = 'cancelled', code_hash = null, decided_at = now()
   where from_agency = me and to_agency = p_to and status in ('pending', 'shown');
  insert into keep_branch_requests (from_agency, to_agency) values (me, p_to) returning id into rid;
  return rid;
end $$;

-- Asked of me (to show "X wants to link as your branch"), and what I asked.
create or replace function public.keep_branch_inbox()
returns table (id uuid, agency_id uuid, name text, city text, status text, created_at timestamptz, code_until timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  return query
    select r.id, r.from_agency, a.name, a.city, r.status, r.created_at, r.code_until
      from keep_branch_requests r join agencies a on a.id = r.from_agency
     where r.to_agency = me and r.status in ('pending', 'shown') and r.created_at > now() - interval '1 day'
     order by r.created_at;
end $$;

create or replace function public.keep_branch_outbox()
returns table (id uuid, agency_id uuid, name text, city text, status text, created_at timestamptz, code_until timestamptz, tries int)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  return query
    select r.id, r.to_agency, a.name, a.city, r.status, r.created_at, r.code_until, r.tries
      from keep_branch_requests r join agencies a on a.id = r.to_agency
     where r.from_agency = me and r.created_at > now() - interval '1 day'
       and r.status in ('pending', 'shown', 'denied', 'expired', 'failed')
     order by r.created_at desc
     limit 20;
end $$;

-- "Yes, it is me": a new 6-digit code for that request, valid 10 minutes.
-- Pressed again: a new code (the old one stops working), at most 5 per request.
create or replace function public.keep_branch_confirm(p_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := keep_branch_caller(); r keep_branch_requests; code text;
begin
  select * into r from keep_branch_requests where id = p_id and to_agency = me for update;
  if r is null or r.status not in ('pending', 'shown') or r.created_at < now() - interval '1 day' then raise exception 'That request is gone.'; end if;
  if r.codes_made >= 5 then raise exception 'Too many codes for this request — ask them to press Connect again.'; end if;
  code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  update keep_branch_requests
     set status = 'shown', code_hash = crypt(code, gen_salt('bf')), code_until = now() + interval '10 minutes',
         codes_made = codes_made + 1, tries = 0
   where id = p_id;
  return code;
end $$;

create or replace function public.keep_branch_deny(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  update keep_branch_requests set status = 'denied', code_hash = null, decided_at = now()
   where id = p_id and (to_agency = me or from_agency = me) and status in ('pending', 'shown');
end $$;

-- The sender types the code. Answers one word:
--   linked · wrong · expired · used · too_many · not_yet · gone
create or replace function public.keep_branch_verify(p_id uuid, p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := keep_branch_caller(); r keep_branch_requests; c text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
begin
  select * into r from keep_branch_requests where id = p_id and from_agency = me for update;
  if r is null then return 'gone'; end if;
  if r.status = 'linked' then return 'used'; end if;
  if r.status = 'pending' then return 'not_yet'; end if;
  if r.status <> 'shown' or r.code_hash is null then return 'gone'; end if;
  if r.code_until < now() then
    update keep_branch_requests set status = 'expired', code_hash = null, decided_at = now() where id = p_id;
    return 'expired';
  end if;
  if r.tries >= 5 then return 'too_many'; end if;
  if char_length(c) <> 6 or r.code_hash <> crypt(c, r.code_hash) then
    update keep_branch_requests set tries = tries + 1,
           status = case when tries + 1 >= 5 then 'failed' else status end,
           code_hash = case when tries + 1 >= 5 then null else code_hash end,
           decided_at = case when tries + 1 >= 5 then now() else decided_at end
     where id = p_id;
    return case when r.tries + 1 >= 5 then 'too_many' else 'wrong' end;
  end if;
  update keep_branch_requests set status = 'linked', code_hash = null, decided_at = now() where id = p_id;
  insert into keep_branch_links (agency_a, agency_b, asked_by)
    values (least(r.from_agency, r.to_agency), greatest(r.from_agency, r.to_agency), r.from_agency)
    on conflict do nothing;
  -- Any other open request between the two is done too.
  update keep_branch_requests set status = 'cancelled', code_hash = null, decided_at = now()
   where id <> p_id and status in ('pending', 'shown')
     and least(from_agency, to_agency) = least(r.from_agency, r.to_agency)
     and greatest(from_agency, to_agency) = greatest(r.from_agency, r.to_agency);
  return 'linked';
end $$;

-- My branches: who, since when, and who shares.
create or replace function public.keep_branch_list()
returns table (agency_id uuid, name text, city text, since timestamptz, i_share boolean, they_share boolean, last_seen timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  return query
    select a.id, a.name, a.city, l.created_at,
           case when l.agency_a = me then l.a_shares else l.b_shares end,
           case when l.agency_a = me then l.b_shares else l.a_shares end,
           a.last_seen
      from keep_branch_links l
      join agencies a on a.id = case when l.agency_a = me then l.agency_b else l.agency_a end
     where me in (l.agency_a, l.agency_b)
     order by a.name;
end $$;

create or replace function public.keep_branch_share(p_other uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  if not keep_branch_linked(me, p_other) then raise exception 'Not linked.'; end if;
  update keep_branch_links
     set a_shares = case when agency_a = me then coalesce(p_on, false) else a_shares end,
         b_shares = case when agency_b = me then coalesce(p_on, false) else b_shares end
   where agency_a = least(me, p_other) and agency_b = greatest(me, p_other);
end $$;

-- Either one ends the link; both stop seeing each other at once.
create or replace function public.keep_branch_unlink(p_other uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := keep_branch_caller();
begin
  delete from keep_branch_links where agency_a = least(me, p_other) and agency_b = greatest(me, p_other);
end $$;

-- The branch's profile summaries (from its online copy, keep_profiles), only
-- while linked and while it shares. Changed since p_since (null: all).
create or replace function public.keep_branch_profiles(p_other uuid, p_since timestamptz default null)
returns table (id bigint, name text, passport text, stage text, status text, nationality text, updated_at timestamptz, deleted boolean)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := keep_branch_caller(); l keep_branch_links;
begin
  select * into l from keep_branch_links where agency_a = least(me, p_other) and agency_b = greatest(me, p_other);
  if l is null then raise exception 'Not linked.'; end if;
  if not (case when l.agency_a = p_other then l.a_shares else l.b_shares end) then return; end if;
  return query
    select p.id, coalesce(p.data->>'full_name', p.data->>'name'), p.data->>'passport_number',
           p.data->>'stage', p.data->>'status', p.data->>'nationality', p.updated_at, p.deleted
      from keep_profiles p
     where p.agency_id = p_other and (p_since is null or p.updated_at > p_since)
     order by p.updated_at
     limit 5000;
end $$;

revoke all on function public.keep_branch_caller() from public;
revoke all on function public.keep_branch_linked(uuid, uuid) from public;
grant execute on function
  public.keep_set_city(text), public.keep_branch_search(text), public.keep_branch_ask(uuid),
  public.keep_branch_inbox(), public.keep_branch_outbox(), public.keep_branch_confirm(uuid),
  public.keep_branch_deny(uuid), public.keep_branch_verify(uuid, text), public.keep_branch_list(),
  public.keep_branch_share(uuid, boolean), public.keep_branch_unlink(uuid),
  public.keep_branch_profiles(uuid, timestamptz)
  to authenticated;

-- ---------------------------------------------------------------------------
-- No second password: the agency's "phone password" (pairing a phone with the
-- PC number + a password) is gone. Phones pair with the PC number and a
-- "Yes, it's me" on the PC (keep_request_join / keep_answer_join). The old
-- functions are dropped and the old hashes cleared; the keep_pairing rows
-- (the PC numbers phones type) stay.
drop function if exists public.keep_set_phone_password(text, text);
drop function if exists public.keep_join(text, text, text);
update public.keep_pairing set pass_hash = null where pass_hash is not null;
