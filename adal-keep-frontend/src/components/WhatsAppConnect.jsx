/**
 * The WhatsApp page's connection line (the owner, 2026-11-26): not connected says so plainly
 * with one Connect button; one click asks the PC's hidden WhatsApp for its QR and shows it at
 * once; while it connects it says so; a failure says why and offers Connect again. Connected,
 * it shows nothing (the list is the page). Nothing opens by itself: only the click starts it.
 * This computer's own WhatsApp on: its own card signs in, this one stays out of the way.
 * Off: ADAL_WA_GATE=0 on the main PC (the cv-log answer carries gate: false).
 */
import { Component, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { wa } from '../lib/whatsapp'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message
const MOVING = ['starting', 'qr', 'code', 'signing-in']
/** What the page is in: 'ready' | 'moving' | 'failed' | 'off' (not connected). */
export function phaseOf(s) {
  if (!s) return null
  if (s.status === 'ready') return 'ready'
  if (MOVING.includes(s.status)) return 'moving'
  if (s.status === 'failed') return 'failed'
  return 'off'
}

function Connect({ onReady }) {
  const [s, setS] = useState(null)
  const [own, setOwn] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => wa.get('/whatsapp').then(r => setS(r.data)).catch(e => setS({ status: 'failed', error: err(e) }))
  useEffect(() => {
    load()
    wa.get('/whatsapp/own').then(r => setOwn(r.data)).catch(() => setOwn(false))
  }, [])
  const ownOn = !!own?.on
  const phase = ownOn ? (own.status === 'ready' ? 'ready' : 'own') : phaseOf(s)
  useEffect(() => { if (phase) onReady?.(phase === 'ready') }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps
  // Asked only while it connects (after a click, or one already under way); nothing when it rests.
  useEffect(() => {
    if (phase !== 'moving') return
    const t = setInterval(() => { if (!document.hidden) load() }, 1500)
    return () => clearInterval(t)
  }, [phase])

  const connect = async () => {
    setBusy(true); setError('')
    setS(x => ({ ...x, status: 'starting', error: null }))
    try { setS((await wa.post('/whatsapp/connect', {}, { timeout: 40000 })).data) }
    catch (e) { setError(err(e)); setS(x => ({ ...x, status: 'failed', error: err(e) })) }
    setBusy(false)
  }

  if (own === null || !s || phase === 'ready' || phase === 'own') return null
  const why = error || s.error
  return (
    <section className="panel space-y-3 p-5" data-wa-connect={phase}>
      {phase === 'moving' ? (
        <>
          <p className="text-lg font-bold">Connecting…</p>
          {s.status === 'qr' && s.qr ? (
            <div className="flex flex-col items-center gap-2">
              <img src={s.qr} alt="WhatsApp QR code" width="240" height="240" className="rounded-xl bg-white p-2" />
              <p className="text-center text-sm text-slate-600 dark:text-slate-300">On the phone: WhatsApp → ⋮ → Linked devices → Link a device → point the camera here.</p>
            </div>
          ) : s.status === 'code' && s.code ? (
            <p className="text-sm">Type this code in WhatsApp on the phone: <b className="font-mono text-2xl tracking-widest" translate="no">{s.code}</b></p>
          ) : s.status === 'signing-in' ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">✓ Linked. WhatsApp is bringing the chats to the PC…</p>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-300">The PC is opening WhatsApp: the QR shows here in a moment.</p>
          )}
        </>
      ) : (
        <>
          <p className="text-lg font-bold">{phase === 'failed' ? 'Did not connect' : 'Not connected'}</p>
          {why && <p className="text-sm text-red-600">{why}</p>}
          {s.status === 'web' && <p className="text-sm text-slate-600 dark:text-slate-300">WhatsApp's own window is open on the PC: close it, then Connect.</p>}
          <Button disabled={busy} onClick={connect}>{phase === 'failed' ? 'Connect again' : 'Connect'}</Button>
        </>
      )}
      {phase === 'moving' && <p className="text-xs text-slate-500">No camera at hand? <Link to="/whatsapp" className="underline">Link with the phone number instead</Link></p>}
    </section>
  )
}

/** Anything wrong in it: nothing shows and the page is as before. */
export default class WhatsAppConnect extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[whatsapp connect]', e); this.props.onReady?.(true) }
  render() { return this.state.bad || this.props.off ? null : <Connect {...this.props} /> }
}
