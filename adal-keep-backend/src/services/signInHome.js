/**
 * signInHome.js — on which PC's robot browser each account is signed in: a person's sign-in (the tick, the code) is
 * kept there, so the account's next runs go there. data/sign-in-homes.json: { "musaned:3": { pc: '' | id, at } }.
 */
import fs from 'fs'
import path from 'path'

const FILE = () => path.resolve(process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data'), 'sign-in-homes.json')
export const HOME_MS = 12 * 3600e3
const read = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {} } catch { return {} } }
export const homeKey = (peer, accountId) => (peer && accountId ? `${peer}:${Number(accountId)}` : '')

export function rememberHome(peer, accountId, pc, now = Date.now()) {
  const key = homeKey(peer, accountId)
  if (!key) return
  try {
    const all = read()
    all[key] = { pc: String(pc || ''), at: now }
    for (const k of Object.keys(all)) if (now - all[k].at > 7 * 86400e3) delete all[k]
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE() + '.new', JSON.stringify(all)); fs.renameSync(FILE() + '.new', FILE())
  } catch {}
}
/** The PC id ('' = this one) where it is signed in, or null. */
export function homeOf(peer, accountId, now = Date.now()) {
  const h = read()[homeKey(peer, accountId)]
  return h && now - h.at < HOME_MS ? String(h.pc || '') : null
}
