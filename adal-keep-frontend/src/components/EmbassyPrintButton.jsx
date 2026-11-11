/**
 * Profile → 🖨 Print for embassy: her embassy page (lib/embassyPrint.js).
 * It prints only when everything is there: she is selected, the application
 * number and the visa number (asked here when missing, and saved on her
 * profile), her photo and what the form prints. Nothing is printed "anyway".
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { loadEmbassy, printEmbassy } from '../lib/embassyPrint'
import { useAuth } from '../context/AuthContext'

const err = (e) => e?.response?.data?.error || e.message
const NUMBERS = ['Application number', 'Visa number']

export default function EmbassyPrintButton({ profile }) {
  const { company } = useAuth()
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState(null)  // { loaded, missing } while the sheet is open
  const [app, setApp] = useState('')
  const [visa, setVisa] = useState('')

  const check = async () => {
    const loaded = await loadEmbassy([profile.id])
    const one = loaded.girls[0]
    if (!one) throw new Error('Nothing to print')
    return { loaded, one }
  }
  const go = async ({ loaded, one }) => {
    await printEmbassy(loaded, [one.g], company || '')
    setAsk(null)
  }
  const print = async () => {
    setBusy(true)
    try {
      const r = await check()
      if (!r.one.missing.length) await go(r)
      else { setApp(''); setVisa(''); setAsk({ ...r, missing: r.one.missing }) }
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  // The two numbers typed here: saved on her profile, then checked again.
  const saveAndPrint = async (e) => {
    e.preventDefault()
    const body = {}
    if (ask.missing.includes('Application number')) body.visa_application_number = app.trim().toUpperCase().replace(/\s+/g, '')
    if (ask.missing.includes('Visa number')) body.visa_number = visa.trim().replace(/\s+/g, '')
    if (Object.values(body).some(v => !v)) return toast.error('Type both numbers')
    setBusy(true)
    try {
      if (Object.keys(body).length) {
        await api.put(`/profiles/${profile.id}`, body)
        window.dispatchEvent(new Event('adal-profile-changed'))
      }
      const r = await check()
      if (r.one.missing.length) setAsk({ ...r, missing: r.one.missing })
      else await go(r)
    } catch (e2) { toast.error(err(e2)) }
    setBusy(false)
  }

  const others = ask ? ask.missing.filter(m => !NUMBERS.includes(m)) : []
  const needApp = ask?.missing.includes('Application number')
  const needVisa = ask?.missing.includes('Visa number')
  return (
    <>
      <button type="button" onClick={print} disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300">
        🖨 {busy ? 'Preparing…' : 'Print for embassy'}
      </button>
      {ask && createPortal(
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setAsk(null)}>
          <form onSubmit={saveAndPrint} onClick={e => e.stopPropagation()}
            className="solid-sheet w-full max-w-md space-y-3 rounded-t-2xl border border-slate-200 p-4 shadow-2xl dark:border-slate-700 sm:rounded-2xl"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-bold">🖨 Print for embassy</p>
                <p className="text-xs text-slate-500">{profile.full_name}: the page prints once everything below is there.</p>
              </div>
              <button type="button" onClick={() => setAsk(null)} className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
            </div>
            {needApp && (
              <label className="block text-sm font-semibold">Application number
                <input autoFocus value={app} onChange={e => setApp(e.target.value)} placeholder="E829092486"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono uppercase dark:border-slate-600 dark:bg-slate-900" />
              </label>
            )}
            {needVisa && (
              <label className="block text-sm font-semibold">Visa number
                <input autoFocus={!needApp} value={visa} onChange={e => setVisa(e.target.value)} placeholder="Visa number"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono dark:border-slate-600 dark:bg-slate-900" />
              </label>
            )}
            {others.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-red-700 dark:text-red-300">Still needed on her profile:</p>
                <div className="flex flex-wrap gap-1">
                  {others.map(m => <span key={m} className="rounded-md bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-200 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-800">✗ {m}</span>)}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAsk(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600">Close</button>
              {(needApp || needVisa) && (
                <button type="submit" disabled={busy} className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                  {busy ? 'Saving…' : others.length ? 'Save the numbers' : 'Save and print'}
                </button>
              )}
            </div>
          </form>
        </div>, document.body)}
    </>
  )
}
