// agency-trust — the PCs' one door to Adal's cloud for their agency certificates
// (docs/equal-pcs.md). NOT DEPLOYED YET (2026-11-23, behind ADAL_EQUAL_PCS).
//
// The same code as adal-keep-backend/src/services/sync/authority.js (copied
// next to this file by `node adal-admin/supabase/functions/agency-trust/copy-shared.mjs`
// before `supabase functions deploy agency-trust --no-verify-jwt`).
// Open to every PC (anon key) for: request, pending, approve, collect, crl, reserve —
// each one checks a signature (a certificate of the agency, or the asking PC's device key).
// Admin's ops (create, admin-approve, revoke) only from Admin (server.mjs) itself,
// which needs Adal's root key and does them with the service key directly.
import { Authority, SupabaseTrustStore, handle } from './shared/authority.js'

const store = new SupabaseTrustStore({ url: Deno.env.get('SUPABASE_URL')!, key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! })
const authority = new Authority({ store, rootPriv: null })
const OPEN = new Set(['request', 'pending', 'approve', 'collect', 'crl', 'reserve'])

Deno.serve(async (req) => {
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  try {
    const body = await req.json()
    if (!OPEN.has(body?.op)) return json(403, { error: 'Not here' })
    return json(200, await handle(authority, body))
  } catch (e) {
    return json((e as { status?: number }).status || 400, { error: (e as Error).message })
  }
})
