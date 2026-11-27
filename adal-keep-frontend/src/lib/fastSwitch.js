/**
 * From one broker (agent, ደላላ) to another at once (the owner, 2026-11-27: "switching from one agent to
 * another takes time"). Each broker's page waited behind a spinner for that broker's girls as whole rows
 * (/api/profiles?broker_id=…) and the broker's own row, and its "not assigned yet" box asked for the whole
 * list again. Now the page shows at once from the girls' list this window has in memory (lib/profilesCache,
 * kept up to date with only the rows that changed), filtered here, and refreshes quietly behind it.
 * Off: ADAL_FAST_AGENT_SWITCH=0 on the PC (asked once a window, remembered on this device), or ?adal_off=agentswitch.
 */
import api from '../services/api'
import { off } from './offSwitch'

const KEY = 'adal-fast-agent-switch'
let on = (() => { try { return localStorage.getItem(KEY) !== '0' } catch { return true } })()
api.get('/app/fast-agent-switch').then(r => {
  const v = r.data?.on !== false
  try { localStorage.setItem(KEY, v ? '1' : '0') } catch {}
  on = v
}).catch(() => {})   // (an older PC: the route is not there — fast)

export const fastSwitch = () => on && !off('agentswitch')

// The brokers this window has seen (their name, contacts, address): a page opens with one at once.
const seen = new Map()
export const keepBroker = (b) => { if (b?.id != null) seen.set(String(b.id), b) }
export const keepBrokers = (list) => { for (const b of list || []) keepBroker(b) }
export const brokerSeen = (id) => seen.get(String(id)) || null

/** This broker's girls, from a list of girls. */
export const girlsOf = (all, id) => (all || []).filter(p => p.broker_id != null && String(p.broker_id) === String(id))
