/**
 * Tray files dragged, copied or pasted anywhere in Adal Keep (the tray, the
 * arrival pop-up). One drag carries one or many files: the first one under
 * the old type (application/x-tray-file-id, which FieldCard and PassportFirst
 * already take) and all of them under application/x-tray-file-ids.
 */
export const TRAY_ID = 'application/x-tray-file-id'
export const TRAY_IDS = 'application/x-tray-file-ids'
export const CLIP_MARK = 'adal-tray:'

export function dragTrayFiles(e, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
  if (!list.length) return
  e.dataTransfer.setData(TRAY_ID, list[0].id)
  e.dataTransfer.setData(TRAY_IDS, JSON.stringify(list.map(f => f.id)))
  e.dataTransfer.setData('application/x-tray-file-index', '0')
  e.dataTransfer.setData('text/plain', list.map(f => f.name).join(', '))
  e.dataTransfer.effectAllowed = 'copyMove'
  window.__DRAGGED_TRAY_FILE__ = list[0]
  window.__DRAGGED_TRAY_FILES__ = list
  window.dispatchEvent(new CustomEvent('adal-tray-drag', { detail: true }))
}

export function endTrayDrag() {
  delete window.__DRAGGED_TRAY_FILE__
  delete window.__DRAGGED_TRAY_FILES__
  window.dispatchEvent(new CustomEvent('adal-tray-drag', { detail: false }))
}

/** True while tray files are dragged (works in dragover, when the data is hidden). */
export const isTrayDrag = (e) => Array.from(e.dataTransfer?.types || []).some(t => t === TRAY_ID || t === TRAY_IDS)

/** The tray files dropped (File objects from the tray). */
export function trayFilesDropped(e, capturedFiles = []) {
  let ids = []
  try { ids = JSON.parse(e.dataTransfer?.getData(TRAY_IDS) || '[]') } catch {}
  if (!ids.length) { const one = e.dataTransfer?.getData(TRAY_ID); if (one) ids = [one] }
  const found = ids.map(id => capturedFiles.find(f => f.id === id)).filter(Boolean)
  if (found.length) return found
  return window.__DRAGGED_TRAY_FILES__ || (window.__DRAGGED_TRAY_FILE__ ? [window.__DRAGGED_TRAY_FILE__] : [])
}

/** Ctrl+C in the tray puts this text on the clipboard; Ctrl+V over a field reads it back. */
export const clipText = (files) => CLIP_MARK + files.map(f => f.id).join(',')
export function trayFilesFromClip(text, capturedFiles = []) {
  if (!text || !text.startsWith(CLIP_MARK)) return []
  return text.slice(CLIP_MARK.length).split(',').map(id => capturedFiles.find(f => f.id === id)).filter(Boolean)
}

/** Typing somewhere (Ctrl+C / Ctrl+V there are the text's own). */
export const typingIn = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

/** Narrow screen or a touch phone: tap instead of drag. */
export const tapMode = () => typeof window !== 'undefined' && (window.innerWidth < 768 || (window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(pointer: fine)').matches))
