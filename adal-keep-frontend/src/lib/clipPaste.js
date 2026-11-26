/**
 * The Paste button of a document box (asked on 2026-11-26): what is copied, as files,
 * read on the PC where the person sits — never on another PC.
 *
 *   1. the page reads it itself (navigator.clipboard.read): a picture copied anywhere
 *      (a screenshot, a picture in a browser, WhatsApp, Telegram); the window asks once
 *      for leave to read the clipboard;
 *   2. a window on the main PC itself: that PC reads its own clipboard
 *      (/api/app/clipboard): files copied in Explorer (pictures and PDFs), and a picture
 *      when the page is not let read it;
 *   3. a window on another PC (a Companion): only what step 1 gives — a file copied in
 *      Explorer there goes with Ctrl+V over the box.
 *
 * pasteFiles() → File[]; else throws an Error whose .why is
 *   'nothing' | 'not-document' | 'refused' | 'cannot' (with words to show).
 * Off: ADAL_PASTE_BUTTON=0 on the PC, or "paste" in the window's off switch.
 */
import api from '../services/api'
import { off } from './offSwitch'

const OK = /^(image\/(jpeg|png|webp|gif|bmp|tiff|heic)|application\/pdf)$/
const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'application/pdf': 'pdf' }
const why = (code, text) => Object.assign(new Error(text), { why: code })
const firefox = () => /firefox/i.test(navigator.userAgent || '')
export const ALLOW = firefox()
  ? 'Firefox asks with a small "Paste" button beside the mouse: press it.'
  : 'Click the ⓘ or 🔒 sign at the left of the window’s address (or its ⋮ menu → Site settings), set Clipboard to Allow, then press Paste again.'

let info = null
/** Is the button shown here, and can this PC read its own clipboard? (asked once per window) */
export function pasteInfo() {
  if (off('paste') || import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_DEMO === '1' || window.Capacitor?.isNativePlatform?.()) return Promise.resolve({ on: false })
  return (info ||= api.get('/app/paste', { adalNoCache: true, timeout: 5000 }).then(r => r.data, () => ({ on: true, here: false })))
}

async function fromPage() {
  if (!navigator.clipboard?.read || !window.isSecureContext) return { cannot: true }
  let items
  try { items = await navigator.clipboard.read() } catch (e) { return { refused: e?.name === 'NotAllowedError' || e?.name === 'SecurityError', cannot: true, e } }
  const files = [], kinds = new Set()
  for (const it of items) {
    for (const t of it.types) {
      // Empty text (a cleared clipboard) is nothing copied.
      if (t === 'text/plain') { try { if (!(await (await it.getType(t)).text()).trim()) continue } catch {} }
      kinds.add(t)
    }
    const t = it.types.find(t => OK.test(t))
    if (!t) continue
    const blob = await it.getType(t)
    files.push(new File([blob], `Pasted ${t.startsWith('image/') ? 'picture' : 'document'} ${new Date().toLocaleString().replace(/[/:]/g, '-')}.${ext[t] || 'bin'}`, { type: t }))
  }
  return { files, kinds: [...kinds] }
}

async function fromThisPC() {
  const r = (await api.get('/app/clipboard', { adalNoCache: true, timeout: 20000 })).data
  if (r.kind === 'files') return { files: r.files.map(f => new File([Uint8Array.from(atob(f.data), c => c.charCodeAt(0))], f.name, { type: f.type })), refused: r.refused }
  return { kind: r.kind, refused: r.refused || [] }
}

export async function pasteFiles({ here = false } = {}) {
  const page = await fromPage()
  if (page.files?.length) return page.files
  // The page could not (not let, or nothing it can read): the PC the person sits at, when it is this one.
  if (here) {
    let pc
    try { pc = await fromThisPC() } catch (e) { pc = { failed: e.response?.data?.error || e.message } }
    if (pc.files?.length) return pc.files
    if (pc.kind === 'not-documents') throw why('not-document', `${pc.refused.slice(0, 3).join(', ')}${pc.refused.length > 3 ? '…' : ''}: only pictures and PDFs can go in a document box.`)
    if (pc.kind === 'text' || (page.kinds || []).some(k => k.startsWith('text/'))) throw why('not-document', 'What is copied is text, not a picture or a file. Copy the picture (or the file in Explorer), then press Paste.')
    if (pc.kind === 'other') throw why('not-document', 'What is copied is not a picture or a PDF.')
    if (pc.failed && page.refused) throw why('refused', `The window may not read the clipboard. ${ALLOW}`)
    if (pc.failed) throw why('cannot', `${pc.failed}. Press Ctrl+V with the mouse over the box instead.`)
    throw why('nothing', 'Nothing is copied. Copy a picture or a file first (right-click → Copy, or Ctrl+C), then press Paste.')
  }
  if (page.refused) throw why('refused', `The window may not read the clipboard. ${ALLOW}`)
  if (page.cannot) throw why('cannot', 'This window cannot read the clipboard. Press Ctrl+V with the mouse over the box instead.')
  if (page.kinds?.some(k => k.startsWith('text/'))) throw why('not-document', 'What is copied is text, not a picture. Copy the picture, then press Paste. (A file copied in Explorer: press Ctrl+V with the mouse over the box.)')
  if (page.kinds?.length) throw why('not-document', 'What is copied is not a picture or a PDF.')
  throw why('nothing', 'Nothing is copied. Copy a picture first, then press Paste. (A file copied in Explorer: press Ctrl+V with the mouse over the box.)')
}
