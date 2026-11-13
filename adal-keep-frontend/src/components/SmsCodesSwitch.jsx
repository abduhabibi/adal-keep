/**
 * Settings → This phone → "Send LMIS codes to Adal Keep": LMIS sends its
 * sign-in code by SMS; with this on, the phone app passes just that code to
 * the main PC (adal-phone SmsCodeReceiver) and the LMIS robot types it — so
 * the code no longer depends on one person's phone being at hand. Only LMIS
 * messages are looked at; nothing else is read, kept or sent.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { cloudCreds } from '../cloud/adapter'

const plugin = () => window.Capacitor?.Plugins?.AdalDiscovery

export default function SmsCodesSwitch() {
  const [st, setSt] = useState(null)   // { on, allowed }
  const load = () => plugin()?.smsForward?.({}).then(setSt).catch(() => setSt(null))
  useEffect(() => { load() }, [])
  if (!plugin()?.smsForward) return null
  const flip = async () => {
    try {
      if (st?.on) { setSt(await plugin().smsForward({ on: false })); return toast.success('LMIS codes are not sent any more') }
      const c = cloudCreds()
      if (!c?.email) return toast.error('Pair this phone with the office PC first')
      const r = await plugin().smsForward({ on: true, url: c.url, anon: c.anon, email: c.email, password: c.password, agency: c.agency })
      setSt(r)
      toast.success(r.allowed ? 'LMIS codes now go to Adal Keep by themselves' : 'Allow "SMS" when Android asks — then LMIS codes go to Adal Keep', { duration: 7000 })
      setTimeout(load, 4000)
    } catch (e) { toast.error(e.message) }
  }
  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" checked={!!st?.on} onChange={flip} className="h-5 w-5 accent-teal-600" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">📩 Send LMIS codes to Adal Keep</span>
          <span className="block text-xs text-slate-500">LMIS's sign-in code (its SMS) goes to the office PC by itself and the robot types it. Only LMIS messages are looked at.</span>
        </span>
      </label>
      {st?.on && !st.allowed && <p className="mt-2 text-xs font-semibold text-amber-700">Android has not allowed SMS yet: turn it off and on again, and press Allow.</p>}
    </div>
  )
}
