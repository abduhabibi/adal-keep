/**
 * uploadOnce.js — a file sent again is saved once.
 *
 * A window that loses the PC in the middle sends its file again by itself, with the
 * same number (X-Adal-Upload): saved already = the same answer again; still being
 * saved = its answer is waited for; not arrived whole the first time = saved now.
 * Kept over a restart (data/upload-ids.json, 2 days). Nothing is done without the number.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const FILE = process.env.ADAL_UPLOAD_IDS || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/upload-ids.json')
const DAYS = 2, MOST = 500
let saved = null                 // id → { at, status, body }
const going = new Map()          // id → Promise<{status, body}|null>
function load() {
  if (saved) return saved
  saved = new Map()
  try { for (const [k, v] of JSON.parse(fs.readFileSync(FILE, 'utf8'))) if (Date.now() - v.at < DAYS * 86400000) saved.set(k, v) } catch {}
  return saved
}
function remember(id, status, body) {
  const s = load()
  s.set(id, { at: Date.now(), status, body })
  while (s.size > MOST) s.delete(s.keys().next().value)
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify([...s])); fs.renameSync(`${FILE}.tmp`, FILE)
  } catch (e) { console.warn('[uploads]', e.message) }
}

export async function uploadOnce(req, res, next) {
  const id = String(req.headers['x-adal-upload'] || '')
  if (!/^[\w-]{8,64}$/.test(id)) return next()
  const again = (a) => { req.resume(); res.set('X-Adal-Upload-Again', '1').status(a.status).json(a.body) }
  const had = load().get(id)
  if (had) return again(had)
  if (going.has(id)) {
    const a = await going.get(id)
    if (res.destroyed || req.destroyed) return
    if (a) return again(a)
    if (going.has(id)) return uploadOnce(req, res, next)     // another of its tries took over
  }
  let done
  going.set(id, new Promise(r => { done = r }))
  const over = (a) => { if (done) { const d = done; done = null; going.delete(id); d(a) } }
  const json = res.json.bind(res)
  // Before the answer goes out: a PC stopped right after saving must know it has it.
  res.json = (body) => {
    if (res.statusCode < 300) { remember(id, res.statusCode, body); over({ status: res.statusCode, body }) } else over(null)
    return json(body)
  }
  // The line broke before the whole file came: nothing is being saved. (After that: it goes on being saved.)
  res.on('close', () => { if (!req.complete) over(null); else setTimeout(() => over(null), 120000).unref?.() })
  next()
}
/** Where one number is: saved (with its answer), being saved now, or never arrived whole. */
export const uploadState = (id) => { const s = load().get(String(id)); return s ? { state: 'saved', status: s.status, body: s.body } : going.has(String(id)) ? { state: 'saving' } : { state: 'none' } }
export const _forget = () => { saved = null; going.clear() }
