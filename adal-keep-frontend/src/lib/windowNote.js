/**
 * The window never reloads or goes elsewhere by itself (asked on 2026-11-25: "it
 * automatically reloads every time"): it says what it would do, in a small note
 * with a button, and the person clicks — or goes on with the page as it is.
 */
import { off } from './offSwitch'

/** Off ("reload" in the off switch): what the window did before, by itself. */
export const byItself = () => off('reload')

export function windowNote(id, text, button, onClick) {
  if (typeof document === 'undefined') return
  const key = `adal-note-${id}`
  let el = document.getElementById(key)
  if (!el) {
    el = document.createElement('div')
    el.id = key
    el.dataset.windowNote = id
    el.setAttribute('role', 'status')
    el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9991;display:flex;gap:10px;align-items:center;max-width:92vw;background:#0f172a;color:#fff;border-radius:999px;font:600 13px system-ui,sans-serif;padding:8px 10px 8px 16px;box-shadow:0 8px 24px rgba(0,0,0,.3)'
    document.body.appendChild(el)
  }
  el.replaceChildren(document.createTextNode(text))
  if (button) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = button
    b.style.cssText = 'border:0;border-radius:999px;background:#0d9488;color:#fff;font:inherit;padding:6px 12px;cursor:pointer'
    b.onclick = onClick
    el.appendChild(b)
  }
  const x = document.createElement('button')
  x.type = 'button'
  x.textContent = '×'
  x.setAttribute('aria-label', 'Close')
  x.style.cssText = 'border:0;background:transparent;color:#cbd5e1;font:inherit;padding:4px 6px;cursor:pointer'
  x.onclick = () => { el.style.display = 'none' }   // (not again for the same thing: the note stays, hidden)
  el.appendChild(x)
}
export const noNote = (id) => { if (typeof document !== 'undefined') document.getElementById(`adal-note-${id}`)?.remove() }

// Has anybody used this window since it opened?
let used = false
if (typeof window !== 'undefined') for (const e of ['keydown', 'pointerdown', 'wheel', 'touchstart']) window.addEventListener(e, () => { used = true }, { passive: true, capture: true })
export const windowUsed = () => used
