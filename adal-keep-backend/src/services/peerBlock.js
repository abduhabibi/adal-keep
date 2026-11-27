/**
 * peerBlock.js — a network cut between PCs without root, for tests (Hamza's brain test,
 * 2026-11-27): ADAL_BLOCK_PEERS=<file> names, one a line, the addresses (http://host:port)
 * or PC ids this PC treats as unreachable. The run claims and the PC copying honour it.
 * Read again at most once a second; no variable, no file, or an empty file: nothing is cut.
 */
import fs from 'fs'

let cache = { at: 0, lines: [] }
export function blockedPeer(urlOrId, env = process.env) {
  const f = env.ADAL_BLOCK_PEERS
  if (!f || !urlOrId) return false
  if (Date.now() - cache.at > 1000) {
    let lines = []
    try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')) } catch {}
    cache = { at: Date.now(), lines }
  }
  const s = String(urlOrId).replace(/\/+$/, '')
  return cache.lines.some(l => s === l.replace(/\/+$/, '') || s.startsWith(l.replace(/\/+$/, '') + '/'))
}
export const _resetBlockCache = () => { cache = { at: 0, lines: [] } }
