import { useEffect, useState, useRef } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import LmisAccountPicker from './LmisAccountPicker'
import MusanedAccountPicker from './MusanedAccountPicker'

// What a paused run is waiting for, in words.
const PAUSE_TEXT = {
  'awaiting-human-submit':    'waiting for you to check the LMIS form and press Submit',
  'awaiting-human-save':      'waiting for you to check the form and press SAVE',
  'awaiting-visa-save':       'waiting for you to type the captcha and press Save on the visa platform',
  'awaiting-insurance-save':  'waiting for you to finish the insurance certificate on FetaP',
  'awaiting-wafid-robot':     'waiting for you to answer Wafid\'s "I am not a robot"',
  'awaiting-musaned-login':   'waiting for you to sign in to Musaned',
  'awaiting-musaned-captcha': 'waiting for you to solve the reCAPTCHA',
  'awaiting-musaned-otp':     'waiting for the OTP code from your phone',
  'Paused by user':           'paused by you — press Continue to queue it again',
}

const CONTINUE_LABEL = {
  'awaiting-musaned-login':   '✔ I signed in — continue',
  'awaiting-musaned-captcha': '✔ I solved the captcha — continue',
  'awaiting-musaned-otp':     '✔ I entered the OTP — continue',
  'awaiting-human-submit':    '↻ Retry uploads',
}

// The person finished the last step in the run's tab: mark the run done.
const COMPLETE_LABEL = {
  'awaiting-human-submit': '✔️ Submit done',
  'awaiting-human-save':   '✔️ SAVE done',
  'awaiting-visa-save':    '✔️ Visa saved',
  'awaiting-insurance-save': '✔️ Insurance done',
}

// Runs that are simply run again when clicked after they finished.
const REPEATABLE = new Set(['musaned_check_chosen', 'wafid_check'])

// Waits that must not run again (a second run would make a second application).
const NO_CONTINUE = new Set(['awaiting-visa-save', 'awaiting-insurance-save'])

const isRetry = (run) => run?.status === 'pending' && String(run.pause_reason || '').startsWith('Retry ')

function describeRun(run) {
  if (!run) return ''
  const n = `Run #${run.id}`
  switch (run.status) {
    case 'running': return `${n} is working in its own browser tab.`
    case 'pending': return isRetry(run)
      ? `${n} is waiting to retry after a failed attempt.`
      : `${n} is waiting in line and starts by itself when a slot frees.`
    case 'paused': return PAUSE_TEXT[run.pause_reason]
      ? `${n} is ${PAUSE_TEXT[run.pause_reason]}.`
      : `${n} is paused: ${run.pause_reason || 'no reason given'}`
    case 'done': return `${n} is complete.`
    case 'cancelled': return `${n} was cancelled.`
    case 'failed': return `${n} failed: ${run.pause_reason || 'no reason given'}`
    default: return `${n}: ${run.status}`
  }
}

function aheadText(n) {
  if (!n) return 'it is next in line'
  return n === 1 ? '1 run is ahead of it' : `${n} runs are ahead of it`
}

export default function ProfileAutomations({ profileId }) {
  const [workflows, setWorkflows] = useState([])
  const [queue, setQueue] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)
  const [accountId, setAccountId] = useState(null)
  const [musanedAccountId, setMusanedAccountId] = useState(null)
  const [visaAccountId, setVisaAccountId] = useState(null)
  const [tasheerAccountId, setTasheerAccountId] = useState(null)
  const [insuranceAccountId, setInsuranceAccountId] = useState(null)
  const [detail, setDetail] = useState(null)
  // Workflows whose click is on its way to the server (one request per card).
  const [sending, setSending] = useState({})
  const pollRef = useRef(null)
  const lastStatus = useRef(null)

  const load = async ({ quiet = false } = {}) => {
    try {
      const r = await api.get(`/profiles/${profileId}/automations`)
      setWorkflows(r.data.workflows || [])
      setQueue(r.data.queue || null)
    } catch {
      if (!quiet) toast.error('Failed to load automations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profileId])

  // Keep the cards and the "working now" list current: a queued run starts by
  // itself when a slot frees, and the card should show it without a reload.
  useEffect(() => {
    const id = setInterval(() => load({ quiet: true }), 4000)
    return () => clearInterval(id)
  }, [profileId])

  useEffect(() => {
    if (!open) return
    lastStatus.current = null
    const tick = async () => {
      try {
        const r = await api.get(`/automations/${open}`)
        setDetail(r.data)
        // Refresh the cards whenever the run changes state (queued → working → paused …).
        if (r.data.status !== lastStatus.current) {
          lastStatus.current = r.data.status
          load({ quiet: true })
        }
      } catch {}
    }
    tick()
    pollRef.current = setInterval(tick, 2000)
    return () => clearInterval(pollRef.current)
  }, [open])

  const wfName = (id) => workflows.find(w => w.id === id)?.name || id

  // Musaned workflows use the Musaned account picker; everything else LMIS.
  const accountFor = (workflowId) =>
    workflowId.startsWith('musaned') ? musanedAccountId
      : workflowId.startsWith('mofa') ? visaAccountId
      : workflowId.startsWith('insurance') ? insuranceAccountId
      : workflowId.startsWith('tasheer') ? tasheerAccountId
      : accountId

  // Show what the server said about a click. A queued run gets an hourglass:
  // it starts by itself when a slot frees.
  const announce = (data, msg, id) => {
    if (data?.state === 'queued') toast(msg, { id, icon: '⏳', duration: 7000 })
    else toast.success(msg, { id, duration: 6000 })
  }

  // One click = one run, started at once in its own tab, or put in line.
  const start = async (workflowId) => {
    if (sending[workflowId]) return
    const name = wfName(workflowId)
    const t = toast.loading(`${name}: checking the profile…`)
    setSending(s => ({ ...s, [workflowId]: true }))
    try {
      const r = await api.post(
        `/profiles/${profileId}/automations/${workflowId}/start`,
        { account_id: accountFor(workflowId) }
      )
      setOpen(r.data.runId)
      announce(r.data, `${name}: ${r.data.message || 'started'}`, t)
      load({ quiet: true })
    } catch (e) {
      toast.error(`${name}: ${e.response?.data?.error || 'could not start'}`, { id: t, duration: 8000 })
    } finally {
      setSending(s => { const n = { ...s }; delete n[workflowId]; return n })
    }
  }

  const act = async (action, fallback, after) => {
    if (!detail) return
    try {
      const r = await api.post(`/automations/${detail.id}/${action}`)
      announce(r.data, r.data.message || fallback)
      if (after) after()
      load({ quiet: true })
    } catch (e) {
      toast.error(e.response?.data?.error || `Could not ${action} run #${detail.id}`, { duration: 8000 })
    }
  }

  const resume = () => act('resume', 'Continued')
  const pause = () => act('pause', 'Paused')
  const complete = () => act('complete', 'Marked complete', () => { setOpen(null); setDetail(null) })

  // Two clicks instead of window.confirm(): desktop webviews suppress native dialogs.
  const [cancelArmed, setCancelArmed] = useState(false)
  const cancel = () => {
    if (!detail) return
    if (!cancelArmed) {
      setCancelArmed(true)
      setTimeout(() => setCancelArmed(false), 4000)
      return
    }
    setCancelArmed(false)
    act('cancel', 'Cancelled', () => { setOpen(null); setDetail(null) })
  }

  // One workflow's card. `n` numbers the steps inside a group box.
  const renderCard = (w, n) => {
          const latest = w.latest
          const st = latest?.status
          const isRunning = st === 'running'
          const isQueued = st === 'pending'
          const isPaused = st === 'paused'
          const isDone = st === 'done'
          const isActive = isRunning || isQueued || isPaused
          const isSending = !!sending[w.id]
          return (
            <button
              key={w.id}
              data-tour={`run-${w.id}`}
              onClick={() => {
                // Every click says at once what is happening. A live run opens
                // its panel; a finished one too, with "Run again" (a second
                // police/Musaned run should be deliberate). Anything else starts.
                if (isActive) {
                  setOpen(latest.id)
                  return toast(describeRun(latest), { icon: isQueued ? '⏳' : 'ℹ️', duration: 5000 })
                }
                // Checking again is normal: a done check simply runs again.
                if (isDone && REPEATABLE.has(w.id)) return start(w.id)
                if (isDone) {
                  setOpen(latest.id)
                  return toast(`${w.name} is already complete for this profile. Press "Run again" below to repeat it.`, { icon: 'ℹ️', duration: 6000 })
                }
                start(w.id)
              }}
              className={`text-left p-3 rounded-xl border transition-colors ${
                isDone
                  ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20'
                  : isPaused
                  ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
                  : isRunning
                  ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-300'
                  : isQueued
                  ? 'border-sky-300 bg-sky-50 dark:bg-sky-900/20'
                  : 'border-slate-200 dark:border-slate-700 hover:border-teal-400 hover:bg-teal-50/40 dark:hover:bg-teal-900/20'
              }`}
            >
              <div className="flex items-center gap-2">
                {n ? <span className="w-5 h-5 shrink-0 rounded-full bg-indigo-600 text-white text-[11px] font-bold flex items-center justify-center">{n}</span> : null}
                <span className="text-lg">{isDone ? '✔️' : '🤖'}</span>
                <span className={`font-semibold text-sm leading-tight ${
                  isDone ? 'text-emerald-800 dark:text-emerald-300' : 'text-slate-900 dark:text-white'
                }`}>{w.name}</span>
              </div>

              {isDone ? (
                <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1 font-medium">
                  ✓ {REPEATABLE.has(w.id) ? 'Checked' : 'Completed'} {latest.finished_at ? '· ' + new Date(latest.finished_at).toLocaleDateString() : ''}
                </p>
              ) : (
                <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{w.description}</p>
              )}

              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-slate-400">
                  {latest && isActive ? `Run #${latest.id}` : `${w.stepCount} steps`}
                </span>
                {isSending && (
                  <span className="text-[10px] font-semibold text-slate-500">Sending…</span>
                )}
                {!isSending && isDone && (
                  <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">{REPEATABLE.has(w.id) ? '↻ Click to check again' : '✔️ Submitted'}</span>
                )}
                {!isSending && isPaused && (
                  <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                    {latest.pause_reason === 'awaiting-human-submit' ? '⏳ Awaiting your Submit'
                      : latest.pause_reason === 'awaiting-human-save' ? '⏳ Awaiting your SAVE'
                      : latest.pause_reason === 'awaiting-visa-save' ? '⏳ Awaiting your visa Save'
                      : latest.pause_reason === 'awaiting-insurance-save' ? '⏳ Awaiting you on FetaP'
                      : '● Paused'}
                  </span>
                )}
                {!isSending && isRunning && (
                  <span className="text-[10px] font-semibold text-blue-700 dark:text-blue-400">● Working · own tab</span>
                )}
                {!isSending && isQueued && (
                  <span className="text-[10px] font-semibold text-sky-700 dark:text-sky-400">
                    {isRetry(latest) ? '↻ Retrying soon' : '⏳ Waiting in line'}
                  </span>
                )}
              </div>
            </button>
          )
  }

  // CV (done on the profile) → Musaned → Wafid → Tasheer → Insurance → the rest.
  const GROUPS = [
    { title: 'Musaned', ids: ['musaned_add_candidate', 'musaned_check_chosen'], box: 'border-indigo-200 dark:border-indigo-800', head: 'text-indigo-700 dark:text-indigo-300' },
    { title: 'Wafid medical', ids: ['wafid_book', 'wafid_check'], box: 'border-emerald-200 dark:border-emerald-800', head: 'text-emerald-700 dark:text-emerald-300' },
    { title: 'Tasheer', ids: [], empty: 'Coming soon — the Tasheer steps are added next.', box: 'border-amber-200 dark:border-amber-800 border-dashed', head: 'text-amber-700 dark:text-amber-300' },
    { title: 'Insurance', ids: ['insurance_certificate'], box: 'border-rose-200 dark:border-rose-800', head: 'text-rose-700 dark:text-rose-300' },
  ]
  const grouped = GROUPS.flatMap(g => g.ids)
  const otherFlows = workflows.filter(w => !grouped.includes(w.id))

  if (loading) return null

  const running = queue?.running || []
  const max = queue?.max || 3

  return (
    <section className="panel p-6">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100 dark:border-slate-700/50">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">AI Actions</h2>
        <span className="text-[10px] text-slate-400 uppercase tracking-wider">Browser automation</span>
      </div>

      {/* What is working right now, across all profiles */}
      <div className="mb-4 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Working now
          <span className="text-slate-400 normal-case font-normal"> · {running.length} of {max}</span>
        </p>
        {running.length === 0 ? (
          <p className="text-xs text-slate-400 mt-1">Nothing is running. Click a workflow and it starts at once.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {running.map(r => {
              const mine = r.profileId === Number(profileId)
              return (
                <button
                  key={r.runId}
                  type="button"
                  disabled={!mine}
                  onClick={() => mine && setOpen(r.runId)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 ${mine ? 'hover:brightness-95 cursor-pointer' : 'cursor-default'}`}
                >
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  #{r.runId} · {wfName(r.workflowId)}
                  <span className="font-normal opacity-80">· {mine ? 'this profile' : `profile #${r.profileId}`}</span>
                </button>
              )
            })}
          </div>
        )}
        <p className="text-[10px] text-slate-400 mt-2">
          Each run works in its own browser tab and never touches another run's tab. When {max} are
          working, the next click waits in line and starts by itself.
        </p>
      </div>

      {/* Login accounts: one small slot per portal. */}
      <div className="acct-compact mb-4 grid gap-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['LMIS', <LmisAccountPicker value={accountId} onChange={setAccountId} />],
          ['Musaned', <MusanedAccountPicker value={musanedAccountId} onChange={setMusanedAccountId} />],
          ['Tasheer', <MusanedAccountPicker value={tasheerAccountId} onChange={setTasheerAccountId}
            endpoint="/tasheer/accounts" what="Tasheer" placeholder="Nuzla Tasheer" userLabel="Username" />],
          ['Insurance (FetaP)', <MusanedAccountPicker value={insuranceAccountId} onChange={setInsuranceAccountId}
            endpoint="/insurance/accounts" what="insurance" placeholder="Nuzla FetaP" userLabel="Username / email" />],
          ['Visa platform', <MusanedAccountPicker value={visaAccountId} onChange={setVisaAccountId}
            endpoint="/visa/accounts" what="visa platform" placeholder="Nuzla visa" userLabel="Login Name" />],
        ].map(([title, picker]) => (
          <div key={title} className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{title} login</p>
            {picker}
          </div>
        ))}
      </div>

      {/* The journey, in order: each portal's actions in one box. */}
      {GROUPS.map(g => {
        const flows = g.ids.map(id => workflows.find(w => w.id === id)).filter(Boolean)
        return (
          <div key={g.title} className={`mb-3 rounded-xl border-2 p-3 ${g.box}`}>
            <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${g.head}`}>{g.title}</p>
            {flows.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {flows.map((w, i) => renderCard(w, flows.length > 1 ? i + 1 : 0))}
              </div>
            ) : (
              <p className="text-xs text-slate-400 py-3 text-center">{g.empty}</p>
            )}
          </div>
        )
      })}

      {otherFlows.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {otherFlows.map(w => renderCard(w))}
        </div>
      )}

      {open && detail && (
        <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                {wfName(detail.workflow_id)} · Run #{detail.id}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">{describeRun(detail)}</p>
              {detail.status === 'pending' && detail.queue && !isRetry(detail) && (
                <p className="text-[11px] text-sky-700 dark:text-sky-400 mt-0.5">
                  ⏳ Waiting in line — {aheadText(detail.queue.ahead)} · {detail.queue.running} of {detail.queue.max} running.
                </p>
              )}
              {isRetry(detail) && (
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{detail.pause_reason}</p>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2 shrink-0">
              {detail.status === 'paused' && !NO_CONTINUE.has(detail.pause_reason) && (
                <button
                  onClick={resume}
                  className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700"
                >
                  {CONTINUE_LABEL[detail.pause_reason] || '▶ Continue'}
                </button>
              )}
              {detail.status === 'paused' && COMPLETE_LABEL[detail.pause_reason] && (
                <button
                  onClick={complete}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                >
                  {COMPLETE_LABEL[detail.pause_reason]}
                </button>
              )}
              {detail.status === 'pending' && (
                <button onClick={pause} className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600">⏸ Hold</button>
              )}
              {['running', 'paused', 'pending'].includes(detail.status) && (
                <button onClick={cancel} className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs font-semibold hover:bg-red-50">{cancelArmed ? 'Click again to cancel' : 'Cancel'}</button>
              )}
              {['done', 'failed', 'cancelled'].includes(detail.status) && (
                <button
                  onClick={() => start(detail.workflow_id)}
                  disabled={!!sending[detail.workflow_id]}
                  className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 disabled:opacity-60"
                >
                  ↻ Run again
                </button>
              )}
              <button onClick={() => { setOpen(null); setDetail(null) }} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">Close</button>
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 font-mono text-[11px] leading-relaxed">
            {(detail.log || []).map((l, i) => (
              <div key={i} className={
                l.level === 'error' ? 'text-red-600'
                : l.level === 'warn' ? 'text-amber-600'
                : 'text-slate-600 dark:text-slate-400'
              }>
                [{new Date(l.ts).toLocaleTimeString()}] {l.msg}
              </div>
            ))}
            {(detail.log || []).length === 0 && <span className="text-slate-400">Waiting for output…</span>}
          </div>
        </div>
      )}
    </section>
  )
}
