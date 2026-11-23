-- ===========================================================================
-- Data protection: one agency must never read another's data.
-- Run once in Supabase -> SQL Editor (after schema.sql, keep-sync.sql, ...). Safe to run again.
--
-- What the audit (adal-keep-backend/tests/rlsAudit.test.js) found:
--   * every table in public has row level security on;
--   * every table's rules say "my agency" (keep_agency() / auth.uid()) or "a member";
--   * the buckets keep, chat, agency-config, adal-updates are private;
--   * ONE GAP: the chat bucket's read rule was "any signed-in agency, any file"
--     (only the random file name protected a receipt or a picture). Now a file
--     opens for the agency that uploaded it and for members of the conversation
--     whose message carries it (or an unlock request of its own).
-- ===========================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop policy if exists chat_read on storage.objects;
    create policy chat_read on storage.objects for select to authenticated using (
      bucket_id = 'chat' and (
        (storage.foldername(name))[1] = auth.uid()::text
        or public.is_admin()
        or exists (select 1 from public.messages m
                   where (m.image_path = name or m.file_path = name) and public.is_member(m.conversation_id))
      )
    );
  end if;
end $$;

-- Nobody but the server (service key) touches these: RLS on, and no rule at all.
alter table if exists public.agency_invites  enable row level security;
alter table if exists public.install_codes   enable row level security;
alter table if exists public.keep_join_tries enable row level security;
alter table if exists public.typing          enable row level security;

-- The audit log of who viewed / exported what is kept on each agency's own PC;
-- when a copy goes to the cloud it is only that agency's to read.
create table if not exists public.keep_audit (
  id         bigint generated always as identity primary key,
  agency_id  uuid not null,
  at         timestamptz not null default now(),
  who        text,
  action     text not null,
  target     text,
  detail     text
);
alter table public.keep_audit enable row level security;
drop policy if exists keep_audit_read on public.keep_audit;
create policy keep_audit_read on public.keep_audit for select using (agency_id = public.keep_agency());
drop policy if exists keep_audit_add on public.keep_audit;
create policy keep_audit_add on public.keep_audit for insert with check (agency_id = auth.uid());
-- (no update, no delete: a log line cannot be changed afterwards)
