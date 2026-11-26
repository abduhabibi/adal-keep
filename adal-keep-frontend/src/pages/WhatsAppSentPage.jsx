/**
 * The WhatsApp page (side menu): which girls' CVs went to which agents, when, by whom,
 * from which PC, and whether they arrived. A page at a time; after that only what
 * changed is asked. Retry a failed one by a click.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'
import { onDataChange } from '../lib/changes'
import PageHeader from '../components/shared/PageHeader'
import OwnWhatsApp from '../components/OwnWhatsApp'
import WhatsAppConnect from '../components/WhatsAppConnect'
import Button from '../components/shared/Button'

const err = (e) => e?.response?.data?.error || e.message
/** [text, colour] of a line. */
export function howFar(r) {
  if (r.status === 'failed') return ['Not sent', 'text-red-600']
  if (r.status === 'withdrawn') return ['Taken back (chosen elsewhere)', 'text-slate-500']
  if (r.status === 'marked') return ['Marked 🔴 selected', 'text-slate-500']
  if (r.status === 'chosen_here') return ['Chosen by this agent', 'text-emerald-700 dark:text-emerald-300']
  if (r.ack >= 3) return ['Read', 'text-sky-700 dark:text-sky-300']
  if (r.ack === 2) return ['Delivered', 'text-emerald-700 dark:text-emerald-300']
  return ['Sent', 'text-slate-700 dark:text-slate-200']
}
/** What changed on top of what is shown: known lines in place, new ones first (newest id first). */
export function mergeRows(old, fresh) {
  const m = new Map(old.map(r => [r.id, r]))
  for (const r of fresh) m.set(r.id, r)
  return [...m.values()].sort((a, b) => b.id - a.id)
}

export default function WhatsAppSentPage() {
  const [rows, setRows] = useState(null)
  const [more, setMore] = useState(false)
  const [agents, setAgents] = useState([])
  const [agent, setAgent] = useState('')
  const [girl, setGirl] = useState('')
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [gate, setGate] = useState(true)
  const [ready, setReady] = useState(null)
  const [ask, setAsk] = useState(0)
  const wasOff = useRef(false)
  // Just connected: the list is asked again, so it shows at once.
  useEffect(() => { if (ready && wasOff.current) setAsk(a => a + 1); wasOff.current = ready === false }, [ready])
  const upto = useRef('')
  const params = useCallback((x = {}) => ({ params: { ...(agent ? { agent } : {}), ...(girl.trim() ? { girl: girl.trim() } : {}), ...(failed ? { status: 'failed' } : {}), ...x } }), [agent, girl, failed])

  useEffect(() => { wa.get('/whatsapp/agents').then(r => setAgents(r.data || [])).catch(() => {}) }, [])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => wa.get('/whatsapp/cv-log', params()).then(({ data }) => {
      if (!live) return
      setRows(data.rows); setMore(data.more); upto.current = data.upto; setError(''); setGate(data.gate !== false)
    }).catch(e => { if (live) { setRows([]); setError(e.response?.status === 404 ? 'Update the main PC first' : err(e)) } }), girl ? 300 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [params, ask]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDataChange(['whatsapp_log'], () => {
    // With "not sent" only, a line that went through leaves the list: asked whole (short) then.
    if (failed) return wa.get('/whatsapp/cv-log', params()).then(({ data }) => { setRows(data.rows); setMore(data.more); upto.current = data.upto }).catch(() => {})
    wa.get('/whatsapp/cv-log', params({ since: upto.current })).then(({ data }) => {
      if (data.rows.length) setRows(x => mergeRows(x || [], data.rows))
      upto.current = data.upto
    }).catch(() => {})
  }, 1000), [params, failed])

  const older = async () => {
    try { const { data } = await wa.get('/whatsapp/cv-log', params({ before: rows.at(-1)?.id })); setRows(x => mergeRows(x, data.rows)); setMore(data.more) } catch (e) { toast.error(err(e)) }
  }
  const retry = async (r) => {
    setBusy(r.id)
    try { await wa.post(`/whatsapp/cv/retry/${r.id}`, {}, { timeout: 180000 }); toast.success(`Sent to ${r.agent_name}`); setRows(x => x.map(y => y.id === r.id ? { ...y, status: 'sent', error: null, ack: 1 } : y)) }
    catch (e) { toast.error(err(e), { duration: 8000 }) }
    setBusy(null)
  }
  const filtering = !!(agent || girl.trim() || failed)
  const when = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }

  return (
    <div className="space-y-4">
      <PageHeader title="WhatsApp" subtitle="CVs sent to agents" />
      <OwnWhatsApp />
      <WhatsAppConnect off={!gate} onReady={setReady} />
      {(!gate || filtering || !!rows?.length) && <div className="flex flex-wrap gap-2">
        <select className="field" value={agent} onChange={e => setAgent(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input className="field min-w-0 flex-1" placeholder="Girl: name or passport" value={girl} onChange={e => setGirl(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={failed} onChange={e => setFailed(e.target.checked)} /> Not sent only</label>
      </div>}
      {error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">{error}</p>}
      {rows === null ? <div className="h-40 rounded-2xl bg-slate-100 dark:bg-slate-800" /> : !rows.length ? (
        // No list: no empty table. Not connected, the Connect card above is all there is.
        !gate || filtering ? <p className="py-10 text-center text-sm text-slate-500">{filtering ? 'Nothing matches' : 'Nothing sent yet'}</p>
          : ready ? <p className="py-6 text-center text-sm text-slate-500">Connected · nothing sent yet</p> : null
      ) : (
        <ul className="panel divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map(r => {
            const [label, cls] = howFar(r)
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' }}>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="truncate font-semibold"><Link to={`/profiles/${r.profile_id}`} translate="no" className="hover:underline">{r.profile_name || 'Deleted profile'}</Link>{!r.template_id && <span className="ml-1 font-normal text-slate-500">video</span>}</p>
                  <p className="truncate text-xs text-slate-500"><span translate="no">{r.agent_name || 'Agent'}</span>{r.template_name ? <span translate="no"> · {r.template_name}</span> : null}</p>
                </div>
                <div className="basis-44 text-xs text-slate-500"><p>{when(r.sent_at)}</p><p className="truncate" translate="no">{[r.sent_by, r.sent_from].filter(Boolean).join(' · ')}</p></div>
                <span className={`basis-28 text-xs font-semibold ${cls}`}>{label}</span>
                {r.status === 'failed' && r.template_id && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => retry(r)}>{busy === r.id ? '…' : 'Retry'}</Button>}
                {r.status === 'failed' && r.error && <p className="w-full text-xs text-red-600">{r.error}</p>}
              </li>
            )
          })}
        </ul>
      )}
      {more && <div className="text-center"><Button variant="secondary" onClick={older}>Older</Button></div>}
    </div>
  )
}
