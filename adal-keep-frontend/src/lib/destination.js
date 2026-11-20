/**
 * The destination country picked in the top bar (asked on 2026-11-19): the
 * Profiles page, its step counts, the dashboard's "Needs action today" and the
 * search pad show only the girls going there. Kept per user and device
 * (localStorage); the girls' countries themselves are profiles.destination_country,
 * which the online copy carries, so a phone or Companion filters the same.
 * A girl with no country counts as Saudi Arabia (the agency works with Musaned/KSA);
 * the empty value is not written back (LMIS treats an empty one as Kuwait).
 */
import { useEffect, useState } from 'react'

export const DEFAULT_COUNTRY = 'Saudi Arabia'
export const COUNTRIES = ['Saudi Arabia', 'UAE', 'Kuwait', 'Qatar', 'Jordan', 'Oman', 'Bahrain', 'Lebanon']
const ALIAS = {
  'ksa': 'Saudi Arabia', 'saudi': 'Saudi Arabia', 'saudi arabia': 'Saudi Arabia', 'kingdom of saudi arabia': 'Saudi Arabia',
  'uae': 'UAE', 'u.a.e': 'UAE', 'u.a.e.': 'UAE', 'united arab emirates': 'UAE', 'emirates': 'UAE', 'dubai': 'UAE',
  'kuwait': 'Kuwait', 'qatar': 'Qatar', 'jordan': 'Jordan', 'oman': 'Oman', 'bahrain': 'Bahrain', 'lebanon': 'Lebanon',
}

/** One name per country ("KSA", "saudi" → "Saudi Arabia"); empty → Saudi Arabia. */
export function countryName(v) {
  const s = String(v ?? '').trim()
  if (!s) return DEFAULT_COUNTRY
  return ALIAS[s.toLowerCase().replace(/\s+/g, ' ')] || s.replace(/\b\w/g, c => c.toUpperCase())
}
export const countryOf = (p) => countryName(p?.destination_country ?? p?.country)

/** The known countries first, then any other found in the data. */
export function countryChoices(rows = []) {
  const extra = new Set()
  for (const p of rows) { const c = countryOf(p); if (!COUNTRIES.includes(c)) extra.add(c) }
  return [...COUNTRIES, ...[...extra].sort()]
}

const userKey = () => {
  let who = 'anyone'
  try { const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null'); if (e?.id) who = `e${e.id}` } catch {}
  return `adal-dest:${who}`
}
const EVENT = 'adal-destination'
export function getDestination() { try { return localStorage.getItem(userKey()) || '' } catch { return '' } }
export function setDestination(v) {
  try { if (v) localStorage.setItem(userKey(), v); else localStorage.removeItem(userKey()) } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: v || '' }))
}
/** '' = all countries. */
export function useDestination() {
  const [dest, setDest] = useState(getDestination)
  useEffect(() => {
    const on = () => setDest(getDestination())
    window.addEventListener(EVENT, on)
    window.addEventListener('storage', on)
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', on) }
  }, [])
  return [dest, setDestination]
}
/** Whether a profile (or a row with destination_country/country) goes to the picked country. */
export const goesTo = (dest, p) => !dest || countryOf(p) === dest
