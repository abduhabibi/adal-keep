/**
 * The off switches of the window's own parts: localStorage 'adal-off' = "pages,images" …
 * (or once ?adal_off=pages in the address; ?adal_off= clears it). A part that misbehaves
 * on one PC is switched off there without a new version.
 */
try {
  const q = new URLSearchParams(location.search)
  if (q.has('adal_off')) localStorage.setItem('adal-off', q.get('adal_off') || '')
} catch {}
export function off(part) {
  try { return (localStorage.getItem('adal-off') || '').split(',').map(s => s.trim()).includes(part) } catch { return false }
}
