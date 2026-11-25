/**
 * This computer's own WhatsApp (WhatsApp page): switched on once by the owner on the main
 * PC, then each computer signs in with its own QR. Nothing is asked while it is off.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message
const SAY = { ready: 'Signed in', starting: 'Opening…', qr: 'Scan this with WhatsApp on your phone: Settings → Linked devices → Link a device', connecting: 'Connecting…' }

export default function OwnWhatsApp() {
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => wa.get('/whatsapp/own').then(r => setS(r.data)).catch(() => setS(false))   // (an older main PC: nothing shows)
  useEffect(() => { load() }, [])
  const moving = ['starting', 'qr', 'connecting'].includes(s?.status)
  useEffect(() => {
    if (!moving) return
    const t = setInterval(() => { if (!document.hidden) load() }, 2000)
    return () => clearInterval(t)
  }, [moving])
  const post = async (what, body = {}) => {
    setBusy(true)
    try { await wa.post(`/whatsapp/own/${what}`, body, { timeout: 40000 }) } catch (e) { toast.error(err(e), { duration: 8000 }) }
    await load(); setBusy(false)
  }
  if (!s || s.never || (!s.on && !s.may_change)) return null
  return (
    <section className="panel flex flex-wrap items-center gap-4 p-4">
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-semibold">WhatsApp on this computer</p>
        <p className="text-sm text-slate-500">{!s.on ? 'Off. When on, every computer signs in to its own WhatsApp and sends from there. WhatsApp does not allow such programs and can block a number.'
          : <>{SAY[s.status] || s.error || 'Not signed in'}{s.status === 'ready' && s.me?.number ? <span translate="no"> · {s.me.name ? `${s.me.name} · ` : ''}+{s.me.number}</span> : null}</>}</p>
        {s.on && s.error && SAY[s.status] && <p className="text-sm text-amber-700 dark:text-amber-300">{s.error}</p>}
      </div>
      {s.on && s.status === 'qr' && s.qr && <img src={s.qr} alt="QR" width="220" height="220" className="rounded-xl bg-white p-2" />}
      <div className="flex flex-wrap gap-2">
        {s.on && ['off', 'failed'].includes(s.status) && s.linked !== false && <Button disabled={busy} onClick={() => post('connect')}>Sign in</Button>}
        {s.on && ['ready', 'qr', 'connecting', 'starting'].includes(s.status) && <Button variant="secondary" disabled={busy} onClick={() => { if (s.status !== 'ready' || confirm('Sign this computer out of WhatsApp?')) post('logout') }}>{s.status === 'ready' ? 'Sign out' : 'Cancel'}</Button>}
        {s.may_change && <Button variant="secondary" disabled={busy} onClick={() => { if (confirm(s.on ? 'Turn off own WhatsApp on every computer?' : 'Turn on own WhatsApp on every computer? WhatsApp can block a number that sends through such a program.')) post('switch', { on: !s.on }) }}>{s.on ? 'Turn off' : 'Turn on'}</Button>}
      </div>
    </section>
  )
}
