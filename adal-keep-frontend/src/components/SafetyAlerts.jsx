/**
 * Warnings on every page — the main PC, a Companion, a phone, Admin's windows:
 *   - no good backup for more than 48 hours (a bar until there is one; "Later"
 *     hides it for 12 hours);
 *   - the licence ends in 7 days, 3 days, 1 day, 12 hours: a notice once per
 *     step on each device.
 * From GET /api/safety (on a phone with the PC off: the online copy of it).
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import { Link } from 'react-router-dom'
import { backupWarning, licenceStep, leftText, ageText, stepShown, markStepShown } from '../lib/safety'

const LATER = 'adal-backup-warning-later'
const laterUntil = () => { try { return Number(localStorage.getItem(LATER)) || 0 } catch { return 0 } }

export default function SafetyAlerts() {
  const [s, setS] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [hiddenUntil, setHiddenUntil] = useState(laterUntil())
  const [step, setStep] = useState(null)
  const [asked, setAsked] = useState('')
  const [billingOn, setBillingOn] = useState(false)

  useEffect(() => {
    let gone = false
    const load = () => api.get('/safety').then(r => { if (!gone) { setS(r.data); setNow(Date.now()) } }).catch(() => {})
    load()
    const t = setInterval(load, 10 * 60 * 1000)
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000)
    return () => { gone = true; clearInterval(t); clearInterval(tick) }
  }, [])

  // A licence step reached that this device has not shown yet.
  useEffect(() => {
    const st = licenceStep(s?.licence, now)
    if (st && !stepShown(st.key)) { setStep(st); api.get('/subscription/billing').then(r => setBillingOn(!!r.data?.enabled)).catch(() => {}) }
  }, [s, now])

  const bw = backupWarning(s?.backup, now)
  const close = () => { if (step) markStepShown(step.key); setStep(null) }
  const backUp = async () => {
    setAsked('…')
    try {
      const { data } = await api.post('/backup/run')
      setAsked(data?.message || (data?.busy ? 'A backup is going already.' : 'Backing up now.'))
    } catch (e) { setAsked(e?.response?.data?.error || e.message) }
  }

  return (
    <>
      {bw && now > hiddenUntil && (
        <div translate="no" role="alert" className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2 text-sm text-amber-900 dark:text-amber-100 flex flex-wrap items-center gap-3">
          <span>
            ⚠️ <b>{bw.never ? 'No backup has been made yet.' : `No good backup for ${ageText(bw.hours)}.`}</b>{' '}
            {bw.never ? '' : `The last one was ${new Date(bw.since).toLocaleString()}. `}
            {s?.backup?.last_error ? `Last try failed: ${s.backup.last_error}. ` : ''}
            Keep the main PC on and connected for a while — or press:
          </span>
          <button type="button" onClick={backUp} className="rounded-md bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700">Back up now</button>
          <button type="button" onClick={() => { const u = Date.now() + 12 * 3600 * 1000; try { localStorage.setItem(LATER, String(u)) } catch {} setHiddenUntil(u) }} className="text-amber-800 dark:text-amber-200 underline">Later</button>
          {asked && <span className="text-xs">{asked}</span>}
        </div>
      )}
      {step && (
        <div className="fixed inset-0 z-[9995] flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div translate="no" role="alertdialog" aria-labelledby="licence-step-title" className="max-w-md rounded-2xl bg-white dark:bg-slate-800 p-5 shadow-xl text-sm text-slate-700 dark:text-slate-200" onClick={e => e.stopPropagation()}>
            <p id="licence-step-title" className="text-base font-bold text-slate-900 dark:text-white">
              ⏰ {s?.licence?.mode === 'trial' ? 'The free trial' : 'Adal Keep\'s paid time'} ends in {leftText(step.left)}
            </p>
            <p className="mt-2">It ends on <b>{new Date(step.end).toLocaleString()}</b>. After that Adal Keep locks until it is renewed (nothing is deleted).</p>
            {s?.licence?.seller_phone && (
              <p className="mt-2">Call <b>{s.licence.seller_phone}</b> and say PC number <b>{s.licence.pc_number}</b>{s.licence.price_etb ? ` (${Number(s.licence.price_etb).toLocaleString('en')} ETB for 6 months)` : ''}.</p>
            )}
            <div className="mt-4 flex items-center justify-end gap-3">
              {billingOn && <Link to="/billing" onClick={close} className="text-teal-700 underline dark:text-teal-300">How to pay</Link>}
              <button type="button" autoFocus onClick={close} className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700">OK</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
