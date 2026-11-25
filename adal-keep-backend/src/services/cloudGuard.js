/**
 * cloudGuard.js — the agency's data goes only to the agency's own online account.
 *
 * The online copy uses the account of the PC it runs on (.adal_chat.json). A Companion that stands
 * in for the main PC has its own: it may be another agency's (a PC that was an agency of its own
 * before), or none yet (a new one was made at once). Its online copy then sent this agency's text
 * and documents there, and answered that account's phones (2026-11-25, U5UO9NM; from the code).
 * So: a PC that joined an agency sends only to the account that agency's main PC told it when it
 * joined; not told, only when a person made this PC the main PC. (Off: ADAL_CLOUD_GUARD=0.)
 */
import { readIdentity } from './sync/identity.js'

/** Why this account may not be used for this agency, or '' when it may. */
export function refusal({ identity, account, role }) {
  if (process.env.ADAL_CLOUD_GUARD === '0') return ''
  if (!identity?.joined_main) return ''                       // an agency's own main PC
  const agencys = identity.online?.agency || null
  if (agencys) return account === agencys ? '' : 'this PC\'s online account is not this agency\'s: nothing goes online from here (the main PC sends it when it is back)'
  return /^(taken|handed over)/.test(role?.how || '') ? '' : 'this PC only stands in for the main PC and has no online account of this agency: nothing goes online from here'
}

let said = ''
export async function accountIsAgencys(db, account) {
  let identity = null, role = null
  try { identity = readIdentity() } catch { return true }
  if (!identity.joined_main) return true
  try { role = JSON.parse((await db('sync_role').where('k', 'main').first('data'))?.data || 'null') } catch {}
  const why = refusal({ identity, account, role })
  if (why && said !== why) console.warn(`[cloud] ${why}`)
  said = why
  return !why
}
