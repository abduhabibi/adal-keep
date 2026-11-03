/**
 * On a profile: the visa's two numbers as barcodes, side by side and the same
 * size — the application number Enjaz gives once the visa is paid (even before
 * it is approved) and the visa number (Musaned's). The embassy print uses the
 * same barcodes.
 */
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { barcodeSvg } from '../lib/barcode'
import { appCode } from '../lib/embassyPrint'

function Tile({ title, value, hint, onClick, action }) {
  const Box = onClick ? 'button' : 'div'
  return (
    <Box type={onClick ? 'button' : undefined} onClick={onClick} title={action || undefined}
      className={`flex min-w-0 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-slate-700 dark:bg-slate-900 ${onClick ? 'transition hover:border-sky-400 hover:shadow-md' : ''}`}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      {value
        ? <>
            <div className="mt-1 w-full overflow-hidden rounded bg-white p-1 [&>svg]:h-14 [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: barcodeSvg(value, { width: 300, height: 56 }) }} />
            <p className="mt-1 font-mono text-sm font-bold tracking-wider text-slate-800 dark:text-slate-100">{value}</p>
          </>
        : <p className="mt-3 text-xs text-slate-400">{hint}</p>}
      {action && <span className="mt-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-400">🔎 {action}</span>}
    </Box>
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
          onClick={find} action={profile.visa_application_number ? 'Check it again (paid or not)' : 'Find it on the visa platform'} />
        <Tile title="Visa number" value={profile.visa_number} hint="From the Musaned contract" />
      </div>
    </section>
  )
}
