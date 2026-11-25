/**
 * The mobile number shown filled in the pop-up: the agency's saved one, only for a girl
 * with none. A person sees it and may change it for her; nothing is saved without their Save.
 */
const blank = (v) => v == null || String(v).trim() === ''
export const digitsOf = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('251') && d.length > 9) d = d.slice(3); if (d.length === 10 && d.startsWith('0')) d = d.slice(1); return d }
export const mobileOk = (v) => /^9\d{8}$/.test(digitsOf(v))
export const sameMobile = (a, b) => mobileOk(a) && digitsOf(a) === digitsOf(b)

/** { value, from: 'typed' | 'hers' | 'agency' | '' }: what her box shows. */
export function mobileShown({ typed, hers, saved }) {
  if (typed !== undefined) return { value: typed, from: 'typed' }
  if (!blank(hers)) return { value: String(hers), from: 'hers' }       // (hers, also when it is not a full number: a person mends it)
  if (mobileOk(saved)) return { value: saved, from: 'agency' }
  return { value: '', from: '' }
}
/**
 * The number to save with the form, or undefined (none). `now`: her number as it is at this
 * moment — the saved one is never put over a number she got meanwhile (another PC).
 */
export function mobileToSave({ typed, hers, saved }, now = hers) {
  const s = mobileShown({ typed, hers, saved })
  if (s.from === 'typed') return blank(s.value) ? undefined : String(s.value).trim()
  return s.from === 'agency' && blank(now) ? s.value : undefined
}
