/**
 * Connect WhatsApp (asked on 2026-11-22), made for the phone: the agency's
 * WhatsApp lives on a staff member's own phone and the office PC is its only
 * linked device. One button: the PC asks WhatsApp for its 8-character code
 * ("Link with phone number"), the code shows here big, WhatsApp on the phone
 * says "Enter code to link new device" — type it, done. No QR across the room.
 * A QR stays as the fallback (another phone's camera). The bell's "WhatsApp is
 * no longer linked" notice opens this page: the same one tap links it again.
 */
import { useEffect, useRef, useState } from 'react'
import { wa } from '../lib/whatsapp'
import { openOutside } from '../lib/phoneApp'
import PageHeader from '../components/shared/PageHeader'
import Card from '../components/shared/Card'
import Button from '../components/shared/Button'

const err = (e) => e?.response?.data?.error || e.message
const digitsOf = (v) => String(v || '').replace(/\D/g, '')

export default function WhatsAppLinkPage() {
  const [s, setS] = useState(null)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showQr, setShowQr] = useState(false)
  const [copied, setCopied] = useState('')
  const [now, setNow] = useState(Date.now())
  const pressed = useRef(0)

  const load = () => wa.get('/whatsapp').then(r => {
    setS(r.data)
    setPhone(p => p || digitsOf(r.data.last_number))
  }).catch(() => {})
  useEffect(() => {
    load()
    // The PC opens WhatsApp's page now: by the time the button is pressed the code comes at once.
    wa.post('/whatsapp/prepare').catch(() => {})
  }, [])
  const linking = ['starting', 'code', 'signing-in', 'qr'].includes(s?.status)
  useEffect(() => {
    const t = setInterval(() => { load(); setNow(Date.now()) }, s?.status === 'ready' ? 15000 : 1500)
    return () => clearInterval(t)
  }, [s?.status])
  // The code is copied by itself: WhatsApp's box takes a paste.
  useEffect(() => {
    if (s?.status === 'code' && s.code && copied !== s.code) { try { navigator.clipboard?.writeText(digitsOrCode(s.code)).then(() => setCopied(s.code)).catch(() => {}) } catch {} }
  }, [s?.status, s?.code])

  const connect = async () => {
    const n = digitsOf(phone)
    if (n.length < 9) { setError('Type the WhatsApp number with its country code, e.g. 2519…'); return }
    setError(''); setBusy(true); pressed.current = Date.now()
    try { setS(x => ({ ...x, status: 'starting' })); setS((await wa.post('/whatsapp/link', { phone: n }, { timeout: 30000 })).data) }
    catch (e) { setError(err(e)) }
    setBusy(false)
  }
  const copy = () => { try { navigator.clipboard?.writeText(digitsOrCode(s.code)); setCopied(s.code) } catch {} }

  if (!s) return <div className="mx-auto max-w-md p-4"><PageHeader title="WhatsApp" /><div className="h-40 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800" /></div>
  const since = pressed.current ? Math.round((now - pressed.current) / 1000) : null

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader title="WhatsApp" />

      {s.status === 'ready' ? (
        <Card>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">✓</span>
            <div className="min-w-0">
              <p className="text-lg font-bold">Connected</p>
              <p className="truncate text-sm text-slate-500">{s.me?.name || 'WhatsApp'}{s.me?.number ? ` · +${s.me.number}` : ''}</p>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">The office PC is linked and stays linked: after restarts and when the internet comes back, it connects by itself.</p>
          {s.timing?.ready_s != null && <p className="mt-2 text-xs text-slate-500">Linked in {s.timing.linked_s}s · ready in {s.timing.ready_s}s</p>}
        </Card>
      ) : s.status === 'code' && s.code ? (
        <Card>
          <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">Type this code in WhatsApp</p>
          <button type="button" onClick={copy} className="mt-3 w-full rounded-2xl bg-slate-900 py-5 text-center font-mono text-4xl font-bold tracking-[0.18em] text-white" translate="no">{s.code}</button>
          <p className="mt-1 text-center text-xs text-slate-500">{copied === s.code ? '✓ Copied — paste it in WhatsApp' : 'Tap the code to copy it'}</p>
          <Button className="mt-4 w-full" onClick={() => openOutside('whatsapp://')}>Open WhatsApp</Button>
          <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm">
            <li>WhatsApp shows <b>“Enter code to link new device”</b>: tap it. <span className="text-slate-500">(No notice? <b>⋮</b> → <b>Linked devices</b> → <b>Link a device</b> → <b>Link with phone number instead</b>.)</span></li>
            <li>Paste or type the code. Adal Keep finishes by itself.</li>
          </ol>
          <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><span className="h-2 w-2 animate-ping rounded-full bg-emerald-500" />Waiting for the code in WhatsApp{since != null ? ` · ${since}s` : ''}</p>
          <p className="mt-2 text-xs text-slate-500">For +{s.phone || digitsOf(phone)} · <button type="button" className="underline" onClick={connect}>New code</button></p>
        </Card>
      ) : s.status === 'signing-in' ? (
        <Card>
          <p className="text-lg font-bold">✓ Linked</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">WhatsApp is bringing the chats to the PC…{since != null ? ` ${since}s` : ''}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full w-1/2 animate-pulse rounded-full bg-emerald-500" /></div>
        </Card>
      ) : s.status === 'web' ? (
        <Card><p className="text-sm">WhatsApp's own window is open on the PC: finish there, or close it and come back.</p></Card>
      ) : (
        <Card>
          <p className="text-lg font-bold">Connect WhatsApp</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The agency's WhatsApp number (the phone that has WhatsApp):</p>
          <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); connect() }}>
            <input className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg dark:border-slate-600 dark:bg-slate-800" inputMode="tel" autoComplete="tel"
              placeholder="2519…" value={phone} onChange={e => setPhone(e.target.value)} />
            <Button type="submit" className="w-full" disabled={busy || s.status === 'starting'}>
              {busy || s.status === 'starting' ? `Asking WhatsApp for the code…${since != null && busy ? ` ${since}s` : ''}` : '💬 Connect WhatsApp'}
            </Button>
          </form>
          {(error || s.error) && <p className="mt-2 text-sm text-red-600">{error || s.error}</p>}
        </Card>
      )}

      {s.status !== 'ready' && (
        <div className="text-center">
          <button type="button" className="text-xs text-slate-500 underline" onClick={() => setShowQr(v => !v)}>{showQr ? 'Hide the QR' : 'Scan a QR instead (another phone)'}</button>
          {showQr && (
            <div className="mt-3 flex flex-col items-center gap-2">
              {s.status === 'qr' && s.qr ? <img src={s.qr} alt="WhatsApp QR code" className="h-64 w-64 rounded-xl bg-white p-2" />
                : <div className="flex h-64 w-64 items-center justify-center rounded-xl bg-slate-100 p-4 text-xs text-slate-500 dark:bg-slate-800">{s.status === 'code' ? 'A code is shown above: use it, or wait for it to end.' : 'The PC is opening WhatsApp… the QR shows here in a moment.'}</div>}
              <p className="text-xs text-slate-500">WhatsApp → ⋮ → Linked devices → Link a device → point the camera here.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const digitsOrCode = (code) => String(code || '').replace(/-/g, '')
