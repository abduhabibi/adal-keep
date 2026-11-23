/**
 * billing.js — payments, renewal and "how to pay" (asked on 2026-11-23).
 *
 * Nothing is charged by the software and no card data is ever kept. The agency
 * pays Adal by telebirr or bank transfer (outside the app); Adal marks the
 * payment received in Adal Keep Admin → Billing (method, reference, amount,
 * date). That
 *   1. adds the paid months to the agency's signed licence (plans.js: the same
 *      paid_until the Authenticator code moves — the per-PC code still works),
 *      which every PC of the agency reads and keeps, and
 *   2. is kept in a payment record (Admin's ledger, and a signed copy for the
 *      agency's own PCs: billing/payments/<PC number>.json).
 * Adal also edits the payment instructions (bank / telebirr details) in Admin;
 * they are signed (billing/instructions.json) and shown on the Billing page and
 * the lock screen. The reminders at 7 days, 3 days, 1 day and 12 hours are
 * SafetyAlerts.jsx (in the app only, no WhatsApp).
 *
 * Everything the PCs show is behind the flag "billing" (ADAL_FLAG_BILLING=1 or
 * data/flags.json {"billing": true}); the licence itself works the same without it.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { localFlag } from './agencyConfig.js'
import { verifyManifest, BUCKET } from './updateChannel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CACHE = () => process.env.ADAL_BILLING_CACHE || path.join(HERE, '..', '..', 'data', 'billing.json')
const DAY = 86400000
export const PRICE_ETB = 49999        // Premium per 6 months (the one plan since 2026-11-23)
export const PRICE_12M_ETB = 89999
export const EXTRA_PC_ETB = 2500      // per extra PC above the included ones, per 6 months (editable in Admin)
export const INCLUDED_PCS = 3
export const PERIOD_DAYS = 182        // one period = 6 months
export const METHODS = ['telebirr', 'bank', 'cash']

export const billingOn = () => localFlag('billing')

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const digits = (v, n) => String(v ?? '').replace(/[^\d+]/g, '').slice(0, n)

/** The payment instructions and prices Adal edits: only these fields, each cleaned. */
export function normalizeInstructions(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : d)
  const u = r.usd && typeof r.usd === 'object' ? r.usd : {}
  const p6 = num(r.price_6m ?? r.price_etb, PRICE_ETB)
  return {
    price_6m: p6, price_etb: p6,
    price_12m: num(r.price_12m, PRICE_12M_ETB),
    extra_pc_etb: num(r.extra_pc_etb, EXTRA_PC_ETB),
    included_pcs: Math.min(50, Math.max(1, Math.round(Number(r.included_pcs)) || INCLUDED_PCS)),
    // Optional "USD-indexed" prices: Adal sets the USD price and today's rate; the ETB amount to pay follows. Off: the ETB prices above.
    usd: { on: u.on === true, usd_6m: num(u.usd_6m, 0), usd_12m: num(u.usd_12m, 0), usd_extra: num(u.usd_extra, 0), rate: num(u.rate, 0), rate_at: u.rate_at ? str(u.rate_at, 40) : null },
    telebirr: { name: str(r.telebirr?.name, 80), number: digits(r.telebirr?.number, 20) },
    banks: (Array.isArray(r.banks) ? r.banks : []).slice(0, 6)
      .map(b => ({ bank: str(b?.bank, 60), account_name: str(b?.account_name, 80), account_number: digits(b?.account_number, 30) }))
      .filter(b => b.bank && b.account_number),
    note: str(r.note, 300),
    phone: digits(r.phone, 20),
    at: r.at ? str(r.at, 40) : null,
  }
}

/** What to pay in ETB: { six, twelve, extra } (USD-indexed: USD price × today's rate, whole ETB). */
export function quote(ins) {
  const i = normalizeInstructions(ins)
  const u = i.usd
  if (u.on && u.rate > 0 && u.usd_6m > 0) {
    const e = (usd) => Math.round(usd * u.rate)
    return { six: e(u.usd_6m), twelve: u.usd_12m > 0 ? e(u.usd_12m) : e(u.usd_6m) * 2, extra: e(u.usd_extra), indexed: true, rate: u.rate, rate_at: u.rate_at }
  }
  return { six: i.price_6m, twelve: i.price_12m, extra: i.extra_pc_etb, indexed: false }
}
/** The amount for a term (6 or 12 months) and a number of extra PCs (the add-on is per 6 months). */
export const amountFor = (ins, term, extraPcs = 0) => { const q = quote(ins); return (Number(term) === 12 ? q.twelve : q.six) + Math.max(0, Math.round(extraPcs)) * q.extra * (Number(term) === 12 ? 2 : 1) }

/** One payment Adal marked received. No card data: only a reference Adal reads off the receipt. */
export function normalizePayment(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const method = METHODS.includes(r.method) ? r.method : null
  if (!method) throw new Error('Method must be telebirr, bank or cash')
  const reference = str(r.reference, 60)
  if (method !== 'cash' && !reference) throw new Error('Type the telebirr / bank reference')
  const amount = Math.round(Number(r.amount))
  if (!(amount > 0) || amount > 10_000_000) throw new Error('Type the amount in ETB')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : new Date(now).toISOString().slice(0, 10)
  if (!Number.isFinite(Date.parse(date))) throw new Error('That date is not right')
  const periods = r.periods != null ? Number(r.periods) : Number(r.term) === 12 ? 2 : Number(r.term) === 6 ? 1 : amount >= PRICE_12M_ETB * 0.95 ? 2 : 1
  if (!(periods > 0) || periods > 8) throw new Error('Periods must be between 1 and 8 (one period = 6 months)')
  return { method, reference, amount, date, periods, note: str(r.note, 200), ...(Number(r.extra_pcs) > 0 ? { extra_pcs: Math.min(50, Math.round(Number(r.extra_pcs))) } : {}) }
}

/** The new "paid until": from today, or from the end of what is paid already. */
export function extendedUntil(paidUntil, now, periods) {
  const from = Math.max(Number(paidUntil) || 0, now)
  return from + Math.round(periods * PERIOD_DAYS) * DAY
}

/** Is this reference already in the list (the same receipt typed twice)? */
export const duplicateOf = (list, p) => p.method !== 'cash' && (list || []).find(x => x.method === p.method && x.reference.toLowerCase() === p.reference.toLowerCase()) || null

/** Revenue and renewals from the ledger and the licences (Admin's dashboard). */
export function revenueSummary(ledger, now = Date.now()) {
  const month = (d) => String(d).slice(0, 7)
  const byMonth = {}
  let total = 0
  for (const p of ledger || []) { byMonth[month(p.date)] = (byMonth[month(p.date)] || 0) + p.amount; total += p.amount }
  const thisMonth = month(new Date(now).toISOString())
  return { total, byMonth, thisMonth: byMonth[thisMonth] || 0 }
}

/** One agency's renewal line: what it is on, when it ends, how long is left. */
export function renewalOf({ licence, firstSeen }, now = Date.now()) {
  const paid = Number(licence?.paid_until) || 0
  const trialEnd = Math.max((Number(firstSeen) || now) + 21 * DAY, Number(licence?.trial_until) || 0)
  if (licence?.suspended) return { state: 'suspended', ends: paid || trialEnd, days: null }
  if (paid > now) return { state: 'paid', ends: paid, days: Math.ceil((paid - now) / DAY) }
  if (trialEnd > now) return { state: 'trial', ends: trialEnd, days: Math.ceil((trialEnd - now) / DAY) }
  return { state: 'expired', ends: Math.max(paid, trialEnd), days: -Math.ceil((now - Math.max(paid, trialEnd)) / DAY) }
}

// ---------------------------------------------------------------------------
// The PC side: read Adal's signed files, keep the last good copy, show them.
// ---------------------------------------------------------------------------
let cache = null, askedAt = 0
function readCache() {
  if (cache) return cache
  try { cache = JSON.parse(fs.readFileSync(CACHE(), 'utf8')) } catch { cache = { instructions: null, payments: [] } }
  return cache
}
function writeCache(c) {
  cache = c
  try { fs.mkdirSync(path.dirname(CACHE()), { recursive: true }); fs.writeFileSync(CACHE(), JSON.stringify(c)) } catch {}
}

/** A signed file { data, signature }: its data, or null when it is not Adal's. */
export function verified(file, expect = {}) {
  if (!file?.data || !file?.signature) return null
  if (expect.pc && String(file.data.pc || '') !== String(expect.pc)) return null
  return verifyManifest(file.data, file.signature) ? file.data : null
}

/** Reads both files from Adal's storage (at most every 10 minutes unless forced). */
export async function refreshBilling(db, pc, { force = false, fetcher = null } = {}) {
  if (!billingOn()) return { skipped: 'flag off' }
  if (!force && Date.now() - askedAt < 10 * 60000) return { skipped: 'recent' }
  askedAt = Date.now()
  const get = fetcher || (async (p) => {
    const c = await import('./chatCloud.js')
    if (!c.chatConfigured()) return null
    const res = await c.cloudCall(db, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${p}?t=${Date.now()}`, undefined, { raw: true, headers: { 'Cache-Control': 'no-cache' } })
    return res.ok ? res.json() : null
  })
  const had = readCache()
  const next = { ...had }
  try {
    const ins = verified(await get('billing/instructions.json'))
    if (ins) next.instructions = normalizeInstructions(ins)
    if (pc) {
      const pay = verified(await get(`billing/payments/${pc}.json`), { pc })
      if (pay) next.payments = (Array.isArray(pay.payments) ? pay.payments : []).slice(-50)
    }
  } catch (e) { return { error: e.message } }
  writeCache(next)
  return { ok: true }
}

/** What the Billing page shows: the licence line, the instructions, the payments so far. */
export function billingPayload(st) {
  const c = readCache()
  const ins = c.instructions || normalizeInstructions({})
  const now = st?.serverTime || Date.now()
  const ends = st?.mode === 'trial' ? st.trialEndsAt : st?.mode === 'active' ? (st.forGood && !st.paidUntil ? null : st.paidUntil) : null
  return {
    enabled: billingOn(),
    mode: st?.mode || null,
    plan_price_etb: quote(ins).six, prices: quote(ins), included_pcs: ins.included_pcs,
    ends_at: ends ? new Date(ends).toISOString() : null,
    days_left: ends ? Math.max(0, Math.ceil((ends - now) / DAY)) : null,
    for_good: !!st?.forGood,
    suspended: !!st?.suspended,
    pc_number: st?.pcNumber || null,
    instructions: ins,
    has_instructions: !!(ins.telebirr.number || ins.banks.length),
    payments: (c.payments || []).slice(-10).reverse(),
  }
}

/** The 6-month price now (the lock screen and the reminders show it). */
export const currentPrice6 = () => quote(readCache().instructions || {}).six
export const __resetForTest = () => { cache = null; askedAt = 0 }
