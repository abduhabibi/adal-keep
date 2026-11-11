/**
 * On a profile: the visa's two numbers as barcodes, side by side and the same
 * size — the application number Enjaz gives once the visa is paid (even before
 * it is approved) and the visa number (Musaned's). The embassy print uses the
 * same barcodes.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { barcodeSvg } from '../lib/barcode'
import { appCode } from '../lib/embassyPrint'

// A number on file: a click copies it.
const copy = (v, what) => navigator.clipboard?.writeText(String(v)).then(() => toast.success(`${what} ${v} copied`, { duration: 2000 })).catch(() => toast.error('Could not copy'))

function Tile({ title, value, hint, onClick, action, again, extra }) {
  const click = value ? () => copy(value, title) : onClick
  const Box = click ? 'button' : 'div'
  return (
    <div className="flex min-w-0 flex-col gap-1">
    <Box type={click ? 'button' : undefined} onClick={click} title={value ? 'Click to copy' : action || undefined}
      className={`flex min-w-0 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-slate-700 dark:bg-slate-900 ${onClick ? 'transition hover:border-sky-400 hover:shadow-md' : ''}`}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      {value
        ? <>
            <div className="mt-1 w-full overflow-hidden rounded bg-white p-1 [&>svg]:h-14 [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: barcodeSvg(value, { width: 300, height: 56 }) }} />
            <p className="mt-1 font-mono text-sm font-bold tracking-wider text-slate-800 dark:text-slate-100">{value}</p>
          </>
        : <p className="mt-3 text-xs text-slate-400">{hint}</p>}
      {value ? <span className="mt-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-400">📋 Click to copy</span>
        : action && <span className="mt-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-400">🔎 {action}</span>}
    </Box>
    {value && again && <button type="button" onClick={onClick} className="text-[11px] text-slate-500 hover:text-sky-700 hover:underline">🔎 {again}</button>}
    {extra}
    </div>
  )
}

/** The application number typed by hand (it is known already: no search). */
function TypeNumber({ profile }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (e) => {
    e.preventDefault()
    const n = v.trim().toUpperCase().replace(/\s+/g, '')
    if (!n) return
    setBusy(true)
    try {
      await api.put(`/profiles/${profile.id}`, { visa_application_number: n })
      toast.success(`Application number ${n} saved`)
      setOpen(false); setV('')
      window.dispatchEvent(new Event('adal-profile-changed'))
    } catch (e2) { toast.error(e2?.response?.data?.error || e2.message) }
    setBusy(false)
  }
  if (!open) return (
    <button type="button" onClick={() => { setV(profile.visa_application_number || ''); setOpen(true) }}
      className="text-[11px] text-slate-500 hover:text-sky-700 hover:underline">✏️ {profile.visa_application_number ? 'Change it by hand' : 'Type it in yourself'}</button>
  )
  return (
    <form onSubmit={save} className="flex gap-1">
      <input autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="E829092486" onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1 font-mono text-xs uppercase dark:border-slate-600 dark:bg-slate-900" />
      <button type="submit" disabled={busy || !v.trim()} className="shrink-0 rounded-lg bg-sky-600 px-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? '…' : 'Save'}</button>
      <button type="button" onClick={() => setOpen(false)} className="shrink-0 px-1 text-xs text-slate-400">✕</button>
    </form>
  )
}

export default function VisaBarcodes({ profile }) {
  const navigate = useNavigate()
  if (!profile.visa_application_number && !profile.visa_number && !profile.chosen_at) return null
  // The visa platform's list (SmartForm), searched by her passport: her
  // application number, and whether the fees are paid.
  const find = async () => {
    try {
      const { data } = await api.post(`/profiles/${profile.id}/automations/mofa_find_app/start`, {})
      toast.success('The visa platform opens — type its captcha when it rings', { duration: 6000 })
      navigate(`/profiles/${profile.id}?run=${data.runId}&t=${Date.now()}`)
    } catch (e) { toast.error(e?.response?.data?.error || e.message, { duration: 8000 }) }
  }
  return (
    <section className="panel p-4">
      <h2 className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">🛂 Visa</h2>
      <div className="grid grid-cols-2 gap-3">
        <Tile title="Application number" value={appCode(profile.visa_application_number)} hint="On the visa platform's list of applications"
          onClick={find} action="Find it on the visa platform" again="Check it again on the visa platform (paid or not)"
          extra={<TypeNumber profile={profile} />} />
        <Tile title="Visa number" value={profile.visa_number} hint="From the Musaned contract" />
      </div>
    </section>
  )
}
