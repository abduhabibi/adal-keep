/**
 * lanServe.js — the main PC hands the signed release it runs to its own Companions (the owner,
 * 2026-11-25: "update the main first, and everyone will update themselves through the main").
 *
 * Only what Adal signed leaves: a file is found by the SHA-256 the signed manifest names, read and
 * hashed again before it is sent (a file changed by hand on this PC is not sent). The Companion
 * checks the signature and every SHA-256 itself (adal-companion lanupdate.go): this PC is not trusted.
 *
 *   releaseHere()    { manifest, signature }: the kept signed release, when it is the one installed here
 *   fileHere(sha)    { file, size } of a file it names, or null
 *
 * Off: ADAL_LAN_UPDATES=0.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { current, currentFile, piecesOf, formsOf, extrasOf, piecePath } from './lanRelease.js'
import { sha256File } from './updateChannel.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HEX = /^[0-9a-f]{64}$/
export const lanUpdatesOn = () => process.env.ADAL_LAN_UPDATES !== '0'

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const mtime = (f) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
let seen = { key: '', env: null }   // (asked every 20 s by every Companion: read again when a file changed)
export function releaseHere({ root = path.join(BACKEND, '..') } = {}) {
  if (!lanUpdatesOn()) return null
  const marker = path.join(root, '.adal-version.json')
  const key = `${marker}|${mtime(marker)}|${mtime(currentFile())}`
  if (seen.key === key) return seen.env
  const env = current()
  seen = { key, env: env && readJSON(marker)?.sha === env.manifest.sha ? env : null }
  return seen.env
}

/** Where a path of the release is on this PC (adal-keep-backend/… is the folder the server runs from). */
export function installedPath(rel, { root, backend }) {
  if (!safeRel(rel)) return null
  return rel.startsWith('adal-keep-backend/') ? path.join(backend, rel.slice('adal-keep-backend/'.length))
    : rel.startsWith('backend/') ? path.join(backend, rel.slice('backend/'.length)) : path.join(root, rel)
}
/** A path inside the release: never out of it, never the agency's data or keys. */
export const safeRel = (rel) => typeof rel === 'string' && rel.length < 400 && /^[^\\:*?"<>|\0]+$/.test(rel) && !rel.startsWith('/')
  && rel.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p)) && !/(^|\/)(\.env[^/]*|data|uploads|logs|\.git|[^/]*\.sqlite[^/]*)(\/|$)/i.test(rel.replace(/(^|\/)node_modules\/.*$/, ''))

let index = { sha: '', byHash: null }
function byHash(manifest, tree) {
  const key = `${manifest.sha}|${!!tree}`
  if (index.sha === key) return index.byHash
  const m = new Map()
  for (const p of piecesOf(manifest, { all: true })) for (const s of formsOf(p)) m.set(s, null)
  for (const x of extrasOf(manifest)) m.set(x.sha256, null)
  for (const list of [manifest.app_files || {}, Object.fromEntries(Object.entries(tree?.files || {}).map(([k, v]) => [k, v[0]]))])
    for (const [rel, s] of Object.entries(list)) if (HEX.test(s) && safeRel(rel) && !m.get(s)) m.set(s, rel)
  for (const p of [...(manifest.programs || [])]) if (p.name && HEX.test(p.sha256 || '')) m.set(p.sha256, p.name)
  index = { sha: key, byHash: m }
  return m
}
let treeSeen = { sha: '', tree: null }
async function treeHere(manifest) {
  if (treeSeen.sha && treeSeen.sha === manifest.tree?.sha256) return treeSeen.tree
  const f = manifest.tree?.sha256 && piecePath(manifest.tree.sha256)
  if (!f) return null
  try { treeSeen = { sha: manifest.tree.sha256, tree: JSON.parse((await import('zlib')).gunzipSync(fs.readFileSync(f)).toString()) }; return treeSeen.tree } catch { return null }
}

const checked = new Map()   // file → "size|mtime|sha" that was hashed
export async function fileHere(sha, { root = path.join(BACKEND, '..'), backend = BACKEND, env = releaseHere({ root }) } = {}) {
  if (!env || !HEX.test(sha || '')) return null
  const m = byHash(env.manifest, await treeHere(env.manifest))
  if (!m.has(sha)) return null
  const rel = m.get(sha)
  for (const f of [piecePath(sha), rel && installedPath(rel, { root, backend })]) {
    if (!f) continue
    try {
      const st = fs.statSync(f)
      const mark = `${st.size}|${st.mtimeMs}|${sha}`
      if (checked.get(f) !== mark) { if ((await sha256File(f)) !== sha) continue; checked.set(f, mark) }
      return { file: f, size: st.size }
    } catch {}
  }
  return null
}
