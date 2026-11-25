/**
 * Own WhatsApp, for whoever asks: this PC's own window, or a Companion's window open
 * on the main PC's pages (then its own server answers, services/pcLink.js).
 */
import { isLocal } from './networkGate.js'
import * as own from './waOwn.js'
import { askPC, linked, lendFile, startPcLink } from './pcLink.js'
import { isCompanion } from './mainPC.js'

const here = (req) => isLocal(req)
const OFF = (req) => ({ status: 'off', own: true, linked: false, error: 'On this computer Adal Keep\'s full copy must be running to sign in to WhatsApp', remote: !here(req) })

export async function stateFor(req, db) {
  if (here(req)) return own.ownState()
  if (!linked(req)) return OFF(req)
  return askPC(req, 'wa.state', {}, 8000)
}
export const connectFor = (req, db) => here(req) ? own.connect(db) : askPC(req, 'wa.connect')
export const logoutFor = (req) => here(req) ? own.logout() : askPC(req, 'wa.logout')
/** The way this page's PC sends (throws with signIn when it is not signed in). */
export async function transportFor(req, db) {
  const s = await stateFor(req, db).catch(e => ({ status: 'off', error: e.message }))
  if (s.status !== 'ready') throw Object.assign(new Error(s.error || 'WhatsApp on this computer is not signed in: WhatsApp page → Sign in'), { signIn: 'own' })
  if (here(req)) return own.ownTransport(db)
  return { key: s.key, label: `WhatsApp on ${s.pc || 'that computer'}`, pc: s.pc, send: (chat, f) => askPC(req, 'wa.send', { chat, token: lendFile(req, f.path), name: f.name, mime: f.mime, caption: f.caption, asFile: f.asFile !== false }, 150_000) }
}

/** A Companion: answers the main PC for its own window's page. */
export function startOwnLink(db) {
  if (own.neverHere()) return
  startPcLink({
    wanted: async () => isCompanion() && await own.ownOn(db),
    handle: async (cmd, a, { take }) => {
      if (cmd === 'wa.state') return own.ownState()
      if (cmd === 'wa.connect') return own.connect(db)
      if (cmd === 'wa.logout') return own.logout()
      if (cmd === 'wa.send') {
        const f = await take(a.token, a.name)
        try { return await own.sendFile(db, a.chat, { path: f.path, name: a.name, mime: a.mime, caption: a.caption, asFile: a.asFile }) } finally { f.done() }
      }
      throw new Error('unknown')
    },
  })
}
