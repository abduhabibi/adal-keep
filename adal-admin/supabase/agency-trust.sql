-- ===========================================================================
-- Every PC equal (docs/equal-pcs.md) — the agency's identity in Adal's cloud.
-- Run once in Supabase: Dashboard → SQL Editor → paste → Run (safe again).
-- NOT RUN YET (2026-11-23): behind ADAL_EQUAL_PCS, nothing uses it until then.
--
-- One table for adal-keep-backend/src/services/sync/authority.js:
--   kind 'agency'   id = agency id: its code, its PRIVATE agency key, its anchor
--                   (signed by Adal's root key on Adal's PC), the revoked list, the slots
--   kind 'request'  a PC asking to join (pc id, device public key), its Yes, its certificate
--   kind 'device'   every certificate given (serial), who said Yes
-- Only the service key reads or writes it (RLS on, no policies): Admin
-- (server.mjs) and the agency-trust function. PCs never read it directly.
-- ===========================================================================
create table if not exists public.agency_trust (
  kind       text not null,
  id         text not null,
  agency_id  text,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);
create index if not exists agency_trust_agency on public.agency_trust (agency_id, kind);
alter table public.agency_trust enable row level security;
revoke all on public.agency_trust from anon, authenticated;
