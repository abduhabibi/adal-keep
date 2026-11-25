/**
 * Brokers found while typing, from the list already here (no request per letter).
 * Every word typed must be in the name, or the digits in a phone number. First the same
 * name, then names that begin with it, then a word that begins with it, then the rest.
 */
const flat = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const digits = (s) => String(s ?? '').replace(/\D/g, '')
export const brokerName = (b) => String(b?.name || b?.full_name || `Broker ${b?.id ?? ''}`).trim()
export const brokerPhone = (b) => String(b?.contact1 || b?.contact2 || '').trim()

export function searchBrokers(brokers, text, limit = 30) {
  const list = (brokers || []).filter(b => Number(b?.id) > 0)
  const q = flat(text), words = q.split(' ').filter(Boolean), num = digits(text)
  if (!q) return [...list].sort((a, b) => brokerName(a).localeCompare(brokerName(b))).slice(0, limit)
  const out = []
  for (const b of list) {
    const n = flat(brokerName(b))
    const byPhone = num.length >= 3 && !/\p{L}/u.test(text) && [b.contact1, b.contact2].some(c => digits(c).includes(num.replace(/^0/, '')))
    if (!byPhone && !words.every(w => n.includes(w))) continue
    const rank = n === q ? 0 : n.startsWith(q) ? 1 : ` ${n}`.includes(` ${q}`) ? 2 : words.every(w => ` ${n}`.includes(` ${w}`)) ? 3 : byPhone ? 4 : 5
    out.push([rank, n, b])
  }
  return out.sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]) || Number(x[2].id) - Number(y[2].id)).slice(0, limit).map(x => x[2])
}

/** What a key does in the list: { at, open, pick (a broker), stop } — `at` is the marked line. */
export function brokerKey(key, { at = 0, open = false, found = [] }) {
  const n = found.length
  if (key === 'ArrowDown') return { open: true, at: n ? (open ? (at + 1) % n : at % n) : 0, stop: true }
  if (key === 'ArrowUp') return { open: true, at: n ? (open ? (at - 1 + n) % n : n - 1) : 0, stop: true }
  // Enter never sends the form from here, and never makes a broker: it picks, or does nothing.
  if (key === 'Enter') return { open: open && !n, at, pick: open && n ? found[Math.min(at, n - 1)] : null, stop: true }
  if (key === 'Escape') return { open: false, at, stop: open }
  return null
}
