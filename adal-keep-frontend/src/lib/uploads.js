/**
 * A picture put on a girl (pasted, dropped, chosen): once is always enough.
 *
 *   - shown in its box at once, saved behind; leaving her page does not stop it;
 *   - the PC not answering, or gone in the middle: sent again by itself (about 5
 *     minutes), with one number, so it is never saved twice (backend uploadOnce.js);
 *   - not saved in the end: said in its box, with Try again — the picture stays there;
 *   - the window is not closed without a word while one is not saved yet.
 */
import api from '../services/api'

const WAITS = [1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000, 60000]
const list = new Map()          // key (girl/box) → [{ id, url, name, type, state: 'saving'|'again'|'failed', why }]
const listeners = new Set()
const tell = () => listeners.forEach(f => { try { f() } catch {} })
export const onUploads = (f) => { listeners.add(f); return () => listeners.delete(f) }
const NONE = []
export const uploadsOf = (key) => list.get(key) || NONE
const set = (key, rows) => { if (rows.length) list.set(key, rows); else list.delete(key); tell() }
const change = (key, id, what) => set(key, uploadsOf(key).map(u => u.id === id ? { ...u, ...what } : u))
const drop = (key, id) => { const u = uploadsOf(key).find(x => x.id === id); set(key, uploadsOf(key).filter(x => x.id !== id)); if (u?.url && !u.kept) setTimeout(() => URL.revokeObjectURL(u.url), 5000) }

const number = () => crypto.randomUUID?.() || `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint32Array(3))].map(n => n.toString(36)).join('')}`
const pause = (ms) => new Promise(r => setTimeout(r, ms))
// Worth sending again: no answer, the PC starting or overloaded, "connecting again". Not: refused (too big, not a picture, no right).
const again = (e) => !e.response || e.response.status >= 500 || e.response.status === 429 || (e.response.status === 401 && e.response.data?.pc_access)
const words = (e) => e.response?.data?.error || (e.response ? `The PC refused it (${e.response.status}).` : 'The PC is not answering.')

/** files → the PC. onSaved(answer, the picture's address here): also after Try again. Resolves with its answer; rejects when it is refused or given up. show: shown in the box meanwhile. */
export async function sendFiles({ key, url, files, name = 'files', fields = {}, show = true, onSaved = () => {}, waits = WAITS, sleep = pause, post = (u, d, c) => api.post(u, d, c) }) {
  const first = files[0], id = number()
  const size = files.reduce((t, f) => t + (f.size || 0), 0)
  // The very same picture pasted again while it is being saved: it is being saved.
  const same = uploadsOf(key).find(u => u.state !== 'failed' && u.sign === `${files.length}:${size}:${first?.type}:${url}` && Date.now() - u.at < 2000)
  if (same) return same.job
  const row = { id, at: Date.now(), name: first?.name || '', type: first?.type || '', state: 'saving', why: '', sign: `${files.length}:${size}:${first?.type}:${url}`,
    url: show && /^image\//.test(first?.type || '') ? URL.createObjectURL(first) : null }
  const run = async () => {
    let err
    for (let i = 0; i <= waits.length; i++) {
      if (i) await sleep(waits[i - 1])
      const fd = new FormData()
      files.forEach(f => fd.append(name, f))
      for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v)
      try {
        const r = await post(url, fd, { headers: { 'Content-Type': 'multipart/form-data', 'X-Adal-Upload': id }, timeout: 30000 + size / 20 })
        if (onSaved(r, row.url)) change(key, id, { kept: true })   // (its box goes on showing it)
        drop(key, id)
        return r
      } catch (e) {
        err = e
        if (!again(e)) break
        change(key, id, { state: 'again', why: words(e) })
      }
    }
    change(key, id, { state: 'failed', why: words(err) })
    throw err
  }
  row.retry = () => { change(key, id, { state: 'saving', why: '' }); const j = run(); change(key, id, { job: j }); j.catch(() => {}) }
  row.forget = () => drop(key, id)
  set(key, [...uploadsOf(key).filter(u => u.state !== 'failed'), row])
  const job = run()
  row.job = job
  change(key, id, { job })
  return job
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', (e) => {
  if ([...list.values()].some(rows => rows.some(u => u.state !== 'failed'))) { e.preventDefault(); e.returnValue = '' }
})
