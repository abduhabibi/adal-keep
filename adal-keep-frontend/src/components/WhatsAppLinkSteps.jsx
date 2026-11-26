/**
 * Linking WhatsApp by code, said as it goes (the owner, 2026-11-26): each step within
 * seconds (starting, WhatsApp's page, typing the number, the code), the X to stop,
 * a failure with its reason and "Try again", and "Send this PC's WhatsApp log" to Adal
 * so a failure at another agency is seen without signing in there.
 */
import { Component, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message

function Steps({ s, onState, onAgain, busy }) {
  const [now, setNow] = useState(Date.now())
  const [sending, setSending] = useState(false)
  const moving = ['starting', 'code'].includes(s?.status)
  useEffect(() => {
    if (s?.status !== 'starting') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [s?.status])
  const cancel = async () => { try { onState?.((await wa.post('/whatsapp/link/cancel')).data) } catch (e) { toast.error(err(e)) } }
  const send = async () => {
    setSending(true)
    try { const { data } = await wa.post('/whatsapp/link-log/send', {}, { timeout: 30000 }); toast.success(data.ticket ? 'Sent to Adal, with this PC\'s logs' : 'Sent to Adal') }
    catch (e) { toast.error(err(e), { duration: 8000 }) }
    setSending(false)
  }
  if (!s || !(moving || s.status === 'failed')) return null
  const secs = s.since ? Math.max(0, Math.round((now - new Date(s.since).getTime()) / 1000)) : null
  return (
    <div className="mt-3 space-y-2 text-sm" data-wa-steps={s.status}>
      {s.status === 'starting' && (
        <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <span className="h-2 w-2 shrink-0 animate-ping rounded-full bg-emerald-500" />
          <span className="min-w-0 flex-1">{s.step || 'Starting WhatsApp on this PC…'}{secs != null && secs > 2 ? ` · ${secs}s` : ''}</span>
          <button type="button" aria-label="Stop" title="Stop" onClick={cancel} className="rounded-full px-2 text-lg leading-none text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">×</button>
        </p>
      )}
      {s.status === 'code' && <p className="text-right"><button type="button" onClick={cancel} className="text-xs text-slate-500 underline">× Stop</button></p>}
      {s.status === 'failed' && (
        <>
          <p className="text-red-600">{s.error || 'WhatsApp did not connect.'}</p>
          <div className="flex flex-wrap gap-2">
            {onAgain && <Button size="sm" disabled={busy} onClick={onAgain}>Try again</Button>}
            <Button size="sm" variant="secondary" disabled={sending} onClick={send}>{sending ? 'Sending…' : 'Send this PC\'s WhatsApp log'}</Button>
          </div>
        </>
      )}
    </div>
  )
}

/** Anything wrong in it: nothing shows, the page is as before. */
export default class WhatsAppLinkSteps extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[whatsapp steps]', e) }
  render() { return this.state.bad ? null : <Steps {...this.props} /> }
}
