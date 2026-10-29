import LiveTab from './LiveTab'
import { IN_PHONE_APP, onBack } from '../lib/phoneApp'
import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { openOnPhone, portalOf } from '../lib/phoneTask'
import { useNavigate, useLocation } from 'react-router-dom'
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
const REPEATABLE = new Set(['musaned_check_chosen', 'wafid_check', 'wafid_slip'])

// Waits that must not run again (a second run would make a second application).
const NO_CONTINUE = new Set(['awaiting-visa-save', 'awaiting-insurance-save'])

const isRetry = (run) => run?.status === 'pending' && String(run.pause_reason || '').startsWith('Retry ')

// On a phone a working task opens as its own screen: the website, fitted to
// the phone, with what it waits for on top.
const PHONE_VIEW = () => IN_PHONE_APP || !!window.__ADAL_CLOUD ||
  (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && innerWidth < 900)

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
  const [aiOpen, setAiOpen] = useState(() => { try { return localStorage.getItem('adal-fold-ai') !== '0' } catch { return true } })
  const foldAI = () => setAiOpen(o => { try { localStorage.setItem('adal-fold-ai', o ? '0' : '1') } catch {} return !o })
  const [open, setOpen] = useState(null)
  const [screen, setScreen] = useState(false)     // the phone's full-screen task view
  const [choose, setChoose] = useState(null)      // phone: do this step here, or let the PC do it?
  const [pcOn, setPcOn] = useState(false)
  useEffect(() => {
    if (!window.__ADAL_CLOUD) return
    import('../cloud/live.js').then(L => setPcOn(L.pcLive())).catch(() => {})
    const on = (e) => setPcOn(!!e.detail)
    window.addEventListener('adal-pc-online', on)
    return () => window.removeEventListener('adal-pc-online', on)
  }, [])
  useEffect(() => choose ? onBack(() => setChoose(null)) : undefined, [choose])
  const navigate = useNavigate()
  const openRun = (id) => { setOpen(id); setAiOpen(true); if (PHONE_VIEW()) setScreen(true) }
  useEffect(() => screen ? onBack(() => setScreen(false)) : undefined, [screen])
  // The PC's tab, live (on the phone app it opens by itself).
  const [liveOpen, setLiveOpen] = useState(null)
  useEffect(() => { if (open && IN_PHONE_APP) setLiveOpen(open) }, [open])
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
  const panelRef = useRef(null)
  const shownFor = useRef(null)

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

  // Opened from a call or a notification (?attention=1 or ?run=<id>): the run
  // that waits for a person opens by itself.
  const attended = useRef(false)
  const location = useLocation()
  useEffect(() => { attended.current = false }, [location.search, profileId])   // a new call: open again
  useEffect(() => {
    if (attended.current || !workflows.length) return
    const q = new URLSearchParams(window.location.search)
    const runId = Number(q.get('run')) || null
    const waiting = workflows.map(w => w.latest).filter(Boolean)
      .find(r => r.status === 'paused') || workflows.map(w => w.latest).filter(Boolean).find(r => r.status === 'running')
    const pick = runId || (q.has('attention') ? waiting?.id : null)
    if (pick) { attended.current = true; openRun(pick) }
  }, [workflows, location.search])

  // The run's panel scrolls into view when it opens (on a phone it is far below the cards).
  useEffect(() => {
    if (!open || !detail || detail.id !== open || shownFor.current === open) return
    shownFor.current = open
    // Twice: the page above may still be growing (pictures, the journey) at first.
    const go = () => panelRef.current?.scrollIntoView({ block: 'start' })
    setTimeout(go, 150); setTimeout(go, 1200)
  }, [open, detail])

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

  // The step on this phone: its website opens here, the sign-in filled.
  const doOnPhone = async (workflowId) => {
    setChoose(null)
    const t = toast.loading('Opening on this phone…')
    try {
      const r = await openOnPhone({ workflowId, profileId, accountId: accountFor(workflowId), title: wfName(workflowId) })
      toast.success(r.signIn ? 'Sign-in filled — press the site\'s Sign in' : 'Opened on this phone', { id: t, duration: 4000 })
    } catch (e) { toast.error(e.message, { id: t }) }
  }

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
      openRun(r.data.runId)
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
                  openRun(latest.id)
                  if (PHONE_VIEW()) return
                  return toast(describeRun(latest), { icon: isQueued ? '⏳' : 'ℹ️', duration: 5000 })
                }
                // On the phone: do it here (its website, signed in) or let the PC do it.
                if (window.__ADAL_CLOUD && portalOf(w.id)) { import('../cloud/live.js').then(L => setPcOn(L.pcLive())).catch(() => {}); return setChoose(w.id) }
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

  // CV (done on the profile) → Musaned → Wafid → Tasheer → Insurance → Enjaz · Visa,
  // then the LMIS steps, each on its own.
  const GROUPS = [
    { title: 'Musaned', ids: ['musaned_add_candidate', 'musaned_check_chosen'], box: 'border-indigo-200 dark:border-indigo-800', head: 'text-indigo-700 dark:text-indigo-300' },
    { title: 'Wafid medical', ids: ['wafid_book', 'wafid_slip', 'wafid_check'], box: 'border-emerald-200 dark:border-emerald-800', head: 'text-emerald-700 dark:text-emerald-300' },
    { title: 'Tasheer', ids: [], empty: 'Coming soon — the Tasheer steps are added next.', box: 'border-amber-200 dark:border-amber-800 border-dashed', head: 'text-amber-700 dark:text-amber-300' },
    { title: 'Insurance', ids: ['insurance_certificate'], box: 'border-rose-200 dark:border-rose-800', head: 'text-rose-700 dark:text-rose-300' },
    { title: 'Enjaz · Visa', ids: ['mofa_visa'], box: 'border-sky-200 dark:border-sky-800', head: 'text-sky-700 dark:text-sky-300' },
    { title: 'LMIS · Contract', ids: ['lmis_contract'], box: 'border-teal-200 dark:border-teal-800', head: 'text-teal-700 dark:text-teal-300' },
    { title: 'LMIS · Police clearance', ids: ['police_certificate'], box: 'border-slate-200 dark:border-slate-700', head: 'text-slate-600 dark:text-slate-300' },
  ]
  const grouped = GROUPS.flatMap(g => g.ids)
  const otherFlows = workflows.filter(w => !grouped.includes(w.id))

  if (loading) return null

  const running = queue?.running || []
  const max = queue?.max || 3

  return (
    <section className="panel p-4 sm:p-6">
      <button type="button" onClick={foldAI} aria-expanded={aiOpen}
        className={`w-full flex items-center justify-between gap-2 text-left pb-3 border-b border-slate-100 dark:border-slate-700/50 ${aiOpen ? 'mb-4' : ''}`}>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">AI Actions</h2>
        <span className="flex items-center gap-2">
          {running.length > 0 && <span className="text-[10px] font-semibold text-indigo-600">{running.length} working</span>}
          <span className={`text-slate-400 text-sm transition-transform ${aiOpen ? '' : '-rotate-90'}`}>▼</span>
        </span>
      </button>
      {aiOpen && <>

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
                  onClick={() => mine ? openRun(r.runId) : navigate(`/profiles/${r.profileId}?run=${r.runId}`)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 hover:brightness-95 cursor-pointer"
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
          ['Enjaz · Visa', <MusanedAccountPicker value={visaAccountId} onChange={setVisaAccountId}
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
        <div ref={panelRef} className="scroll-mt-24 mt-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
            <div className="run-actions flex flex-wrap gap-1.5 sm:justify-end sm:gap-2 sm:shrink-0">
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

          {['running', 'paused'].includes(detail.status) && (
            PHONE_VIEW()
              ? <button type="button" onClick={() => setScreen(true)}
                  className="w-full rounded-xl bg-indigo-600 text-white py-3 text-sm font-semibold">🌐 Open the website of this task</button>
              : liveOpen === detail.id
              ? <LiveTab runId={detail.id} />
              : <button type="button" onClick={() => setLiveOpen(detail.id)}
                  className="w-full rounded-lg border-2 border-dashed border-indigo-300 dark:border-indigo-700 py-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                  📱 Show the PC's tab here (answer a captcha or press Submit from this screen)
                </button>
          )}

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
      </>}
      {choose && createPortal(
        <div className="fixed inset-0 z-[96] bg-black/40 flex items-end" onClick={() => setChoose(null)}>
          <div className="w-full rounded-t-2xl bg-white dark:bg-slate-900 p-4 space-y-2.5" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
            <p className="font-bold">{wfName(choose)}</p>
            <button onClick={() => doOnPhone(choose)} className="w-full rounded-xl bg-indigo-600 text-white py-3 text-sm font-semibold text-left px-4">
              📱 Do it on this phone<span className="block text-[11px] font-normal opacity-90">Its website opens here, signed in for you — only phone and internet</span>
            </button>
            <button onClick={() => { const w = choose; setChoose(null); start(w) }} className="w-full rounded-xl border border-slate-300 dark:border-slate-600 py-3 text-sm font-semibold text-left px-4">
              💻 The PC does it<span className="block text-[11px] font-normal text-slate-500">{pcOn ? 'It starts now on the office PC; you watch it here' : 'The office PC is off — it starts when the PC is on'}</span>
            </button>
            <button onClick={() => setChoose(null)} className="w-full py-2 text-sm text-slate-500">Cancel</button>
          </div>
        </div>,
        document.body)}
      {screen && open && !(detail && detail.id === open) && createPortal(
        <div className="fixed inset-0 z-[95] flex flex-col items-center justify-center gap-3 bg-white dark:bg-slate-950 text-sm text-slate-500">
          <div className="w-8 h-8 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
          <p>Opening task #{open}…</p>
          <button onClick={() => setScreen(false)} className="px-4 py-2 rounded-lg border border-slate-300">Back</button>
        </div>,
        document.body)}
      {screen && open && detail && detail.id === open && createPortal(
        <div className="fixed inset-0 z-[95] flex flex-col bg-white dark:bg-slate-950" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="shrink-0 border-b border-slate-200 dark:border-slate-800 px-2 pt-2 pb-1.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setScreen(false)} className="shrink-0 rounded-lg px-2.5 py-1.5 text-base font-bold active:bg-slate-100 dark:active:bg-slate-800" aria-label="Back">‹</button>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold truncate">{wfName(detail.workflow_id)} <span className="font-normal text-slate-400">#{detail.id}</span></p>
                <p className={`text-[11px] leading-tight ${detail.status === 'paused' ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-slate-500'}`}>
                  {detail.status === 'paused' ? '🖐 ' : detail.status === 'running' ? '⚙️ ' : ''}{describeRun(detail)}
                </p>
              </div>
            </div>
            {(detail.status === 'paused' || ['running', 'pending'].includes(detail.status)) && (
              <div className="flex gap-1.5 overflow-x-auto">
                {detail.status === 'paused' && !NO_CONTINUE.has(detail.pause_reason) && (
                  <button onClick={resume} className="shrink-0 px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold">{CONTINUE_LABEL[detail.pause_reason] || '▶ Continue'}</button>
                )}
                {detail.status === 'paused' && COMPLETE_LABEL[detail.pause_reason] && (
                  <button onClick={() => { complete(); setScreen(false) }} className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold">{COMPLETE_LABEL[detail.pause_reason]}</button>
                )}
                <button onClick={cancel} className="shrink-0 px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs font-semibold">{cancelArmed ? 'Tap again to cancel' : 'Cancel'}</button>
                {portalOf(detail.workflow_id) && <button onClick={() => doOnPhone(detail.workflow_id)} className="shrink-0 px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-semibold">📱 On this phone</button>}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 p-1.5">
            {['running', 'paused'].includes(detail.status)
              ? <LiveTab runId={detail.id} fill />
              : <div className="h-full grid place-items-center text-center text-sm text-slate-500 p-6">
                  <div className="space-y-3">
                    <p>{detail.status === 'pending' ? '⏳ Waiting in line — it starts by itself, and its website shows here.' : detail.status === 'done' ? '✅ Done.' : describeRun(detail)}</p>
                    <button onClick={() => setScreen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm">Close</button>
                  </div>
                </div>}
          </div>
        </div>,
        document.body)}
    </section>
  )
}
