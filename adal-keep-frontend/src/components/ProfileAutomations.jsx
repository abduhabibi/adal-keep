import { useEffect, useState, useRef } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import LmisAccountPicker from './LmisAccountPicker'
import MusanedAccountPicker from './MusanedAccountPicker'

// Colour classes per agent colour key (from the backend agentRegistry).
// Kept as static strings so Tailwind's JIT keeps them in the build.
const AGENT_COLOR = {
  green:  { dot: 'bg-emerald-500', chip: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-300 text-emerald-700 dark:text-emerald-300', ring: 'ring-emerald-400' },
  blue:   { dot: 'bg-blue-500',    chip: 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 text-blue-700 dark:text-blue-300',             ring: 'ring-blue-400' },
  purple: { dot: 'bg-violet-500',  chip: 'bg-violet-50 dark:bg-violet-900/30 border-violet-300 text-violet-700 dark:text-violet-300',   ring: 'ring-violet-400' },
  orange: { dot: 'bg-orange-500',  chip: 'bg-orange-50 dark:bg-orange-900/30 border-orange-300 text-orange-700 dark:text-orange-300',   ring: 'ring-orange-400' },
  pink:   { dot: 'bg-pink-500',    chip: 'bg-pink-50 dark:bg-pink-900/30 border-pink-300 text-pink-700 dark:text-pink-300',             ring: 'ring-pink-400' },
  teal:   { dot: 'bg-teal-500',    chip: 'bg-teal-50 dark:bg-teal-900/30 border-teal-300 text-teal-700 dark:text-teal-300',             ring: 'ring-teal-400' },
  red:    { dot: 'bg-red-500',     chip: 'bg-red-50 dark:bg-red-900/30 border-red-300 text-red-700 dark:text-red-300',                   ring: 'ring-red-400' },
  indigo: { dot: 'bg-indigo-500',  chip: 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-300 text-indigo-700 dark:text-indigo-300',   ring: 'ring-indigo-400' },
  cyan:   { dot: 'bg-cyan-500',    chip: 'bg-cyan-50 dark:bg-cyan-900/30 border-cyan-300 text-cyan-700 dark:text-cyan-300',             ring: 'ring-cyan-400' },
  amber:  { dot: 'bg-amber-500',   chip: 'bg-amber-50 dark:bg-amber-900/30 border-amber-300 text-amber-700 dark:text-amber-300',       ring: 'ring-amber-400' },
}

// Human labels for an agent's portal assignment.
const ASSIGN_LABEL = { musaned: 'Musaned', lmis: 'LMIS' }

export default function ProfileAutomations({ profileId }) {
  const [workflows, setWorkflows] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)
  const [accountId, setAccountId] = useState(null)
  const [musanedAccountId, setMusanedAccountId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [agents, setAgents] = useState([])
  const [assignOpen, setAssignOpen] = useState(null)
  // Workflow waiting for the operator to pick which agent runs it.
  const [pickerFor, setPickerFor] = useState(null)
  const pollRef = useRef(null)

  const load = async () => {
    try {
      const r = await api.get(`/profiles/${profileId}/automations`)
      setWorkflows(r.data.workflows || [])
    } catch {
      toast.error('Failed to load automations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profileId])

  // Poll the live agent pool so the cards can show which coloured agent is
  // working on each workflow (Agent 1 = green, 2 = blue, 3 = purple, ...).
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await api.get('/agents')
        if (alive) setAgents(r.data?.agents || [])
      } catch {}
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!open) return
    const tick = async () => {
      try {
        const r = await api.get(`/automations/${open}`)
        setDetail(r.data)
        if (['done', 'cancelled', 'failed'].includes(r.data.status)) load()
      } catch {}
    }
    tick()
    pollRef.current = setInterval(tick, 2000)
    return () => clearInterval(pollRef.current)
  }, [open])

  // Pick the right account for the workflow. Musaned workflows get the
  // Musaned picker's value; everything else gets the LMIS one.
  const accountForWorkflow = (wf) =>
    wf.id.startsWith('musaned') ? musanedAccountId : accountId

  // `laneId` = the numbered agent the operator picked, or null for "automatic"
  // (any free agent). It travels with the job so only that agent runs it.
  const start = async (wf, laneId = null) => {
    try {
      const r = await api.post(
        `/profiles/${profileId}/automations/${wf.id}/start`,
        { account_id: accountForWorkflow(wf), agent_lane_id: laneId }
      )
      setOpen(r.data.runId)
      toast.success(r.data.resumed ? 'Resumed' : 'Started')
      load()
    } catch (e) {
      const data = e.response?.data || {}
      if (data.missing) toast.error('Missing: ' + data.missing.join(', '))
      else if (data.alreadyDone) toast.error('This workflow already completed for this profile.')
      else toast.error(data.error || 'Failed to start')
    }
  }

  // Operator clicked a workflow: ask which agent should run it first.
  const chooseAgent = (wf, laneId) => {
    setPickerFor(null)
    start(wf, laneId)
  }

  const resume = async () => {
    if (!detail) return
    try {
      await api.post(`/automations/${detail.id}/resume`)
      toast.success('Resumed')
    } catch { toast.error('Failed to resume') }
  }

  const pause = async () => {
    if (!detail) return
    try {
      await api.post(`/automations/${detail.id}/pause`)
      toast.success('Paused')
    } catch { toast.error('Failed to pause') }
  }

  // Two clicks instead of window.confirm(): desktop webviews suppress native dialogs.
  const [cancelArmed, setCancelArmed] = useState(false)
  const cancel = async () => {
    if (!detail) return
    if (!cancelArmed) {
      setCancelArmed(true)
      setTimeout(() => setCancelArmed(false), 4000)
      return
    }
    setCancelArmed(false)
    try {
      await api.post(`/automations/${detail.id}/cancel`)
      toast.success('Cancelled')
      setOpen(null)
      setDetail(null)
      load()
    } catch { toast.error('Failed') }
  }

  // Manually pin an agent to a portal (musaned / lmis) or clear it ("any").
  const assignAgent = async (laneId, assignment) => {
    try {
      await api.patch(`/agents/${laneId}`, { assignment })
      toast.success(
        assignment ? `${ASSIGN_LABEL[assignment]} agent assigned` : 'Agent set to any portal'
      )
      setAssignOpen(null)
      const r = await api.get('/agents')
      setAgents(r.data?.agents || [])
    } catch {
      toast.error('Failed to assign agent')
    }
  }

  if (loading) return null

  return (
    <section className="panel p-6">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100 dark:border-slate-700/50">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">AI Actions</h2>
        <span className="text-[10px] text-slate-400 uppercase tracking-wider">Browser automation</span>
      </div>

      {/* Live agents (coloured) — who is working right now */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Agents
          {agents.length > 0 && (
            <span className="text-slate-400 normal-case font-normal">
              {' '}· {agents.filter(a => a.state === 'working').length} working
            </span>
          )}
        </p>
        {agents.length === 0 ? (
          <span className="text-xs text-slate-400">No agents running yet.</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agents.map(a => {
              const c = AGENT_COLOR[a.color?.key] || AGENT_COLOR.green
              const isOpen = assignOpen === a.laneId
              const assign = a.assignment || null
              return (
                <div key={a.id} className="relative">
                  <button
                    type="button"
                    onClick={() => setAssignOpen(isOpen ? null : a.laneId)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${c.chip} cursor-pointer hover:brightness-95`}
                    title={`${a.current?.profileName || ''}${assign ? ' · assigned to ' + ASSIGN_LABEL[assign] : ' · click to assign'}`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${c.dot} ${a.state === 'working' ? 'animate-pulse' : ''}`} />
                    {a.label}
                    {assign && (
                      <span className="ml-0.5 px-1 rounded bg-white/60 dark:bg-black/30 text-[9px] uppercase tracking-wide">
                        {ASSIGN_LABEL[assign]}
                      </span>
                    )}
                    <span className="font-normal opacity-80">
                      {a.state === 'working' && a.current
                        ? `· ${a.current.workflowId}`
                        : '· idle'}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="absolute z-20 mt-1 left-0 w-44 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-1">
                      <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">
                        Assign {a.label}
                      </p>
                      {[
                        { key: null, label: 'Any portal' },
                        { key: 'musaned', label: 'Musaned' },
                        { key: 'lmis', label: 'LMIS' },
                      ].map(opt => (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => assignAgent(a.laneId, opt.key)}
                          className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-slate-100 dark:hover:bg-slate-800 ${
                            assign === opt.key
                              ? 'font-bold text-teal-600'
                              : 'text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <p className="text-[10px] text-slate-400 mt-2">
          Click an agent to assign it. A Musaned/LMIS agent keeps its logged-in tab and continues
          with the next person — no re-login.
        </p>
      </div>

      <div className="mb-4 grid sm:grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">LMIS login account</p>
          <LmisAccountPicker value={accountId} onChange={setAccountId} />
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Musaned login account</p>
          <MusanedAccountPicker value={musanedAccountId} onChange={setMusanedAccountId} />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {workflows.map(w => {
          const latest = w.latest
          const isActive = latest && ['running', 'paused', 'pending'].includes(latest.status)
          const isPaused = latest?.status === 'paused'
          const isDone = latest?.status === 'done'
          // Which coloured agents are working this workflow right now.
          const wfAgents = agents.filter(a => a.current && a.current.workflowId === w.id)
          const ac = wfAgents.length ? (AGENT_COLOR[wfAgents[0].color?.key] || AGENT_COLOR.green) : null
          return (
            <button
              key={w.id}
              onClick={() => {
                // A finished run opens the picker too (it is shown as "runs again").
                // No window.confirm(): desktop webviews suppress native dialogs.
                if (isActive) return setOpen(latest.id)
                // Ask which agent should run this before doing anything.
                setPickerFor(w)
              }}
              className={`text-left p-3 rounded-xl border transition-colors ${
                isDone
                  ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20'
                  : isPaused
                  ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
                  : isActive
                  ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-slate-200 dark:border-slate-700 hover:border-teal-400 hover:bg-teal-50/40 dark:hover:bg-teal-900/20'
              } ${ac ? `ring-2 ${ac.ring}` : ''}`}
            >
              <div className="flex items-center gap-2">
                {isDone ? (
                  <span className="text-lg">✔️</span>
                ) : (
                  <span className="text-lg">🤖</span>
                )}
                <span className={`font-semibold text-sm truncate ${
                  isDone ? 'text-emerald-800 dark:text-emerald-300' : 'text-slate-900 dark:text-white'
                }`}>{w.name}</span>
              </div>

              {isDone ? (
                <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1 font-medium">
                  ✓ Completed {latest.finished_at ? '· ' + new Date(latest.finished_at).toLocaleDateString() : ''}
                </p>
              ) : (
                <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{w.description}</p>
              )}

              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-slate-400">{w.stepCount} steps</span>
                {isDone && (
                  <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">✔️ Submitted</span>
                )}
                {isPaused && latest.pause_reason === 'awaiting-human-submit' && (
                  <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">⏳ Awaiting your Submit</span>
                )}
                {isPaused && latest.pause_reason !== 'awaiting-human-submit' && (
                  <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">● Paused</span>
                )}
                {isActive && !isPaused && (
                  <span className="text-[10px] font-semibold text-blue-700 dark:text-blue-400">● Running</span>
                )}
              </div>

              {wfAgents.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-2">
                  {wfAgents.map(a => {
                    const c = AGENT_COLOR[a.color?.key] || AGENT_COLOR.green
                    return (
                      <span
                        key={a.id}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${c.chip}`}
                        title={a.current?.profileName || ''}
                      >
                        <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                        {a.label}
                      </span>
                    )
                  })}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {open && detail && (
        <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                {detail.workflow_name || detail.workflow_id}
              </p>
              <p className="text-[11px] text-slate-500">
                Status: <b>{detail.status}</b>{detail.pause_reason ? ' — ' + detail.pause_reason : ''}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              {detail.status === 'paused' && (
                <button
                  onClick={resume}
                  className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700"
                >
                  {detail.pause_reason === 'awaiting-musaned-signin'
                    ? '✔ I signed in — continue'
                    : detail.pause_reason === 'awaiting-musaned-otp'
                    ? '✔ I entered the OTP — continue'
                    : detail.pause_reason === 'awaiting-human-submit'
                    ? '↻ Retry uploads'
                    : '▶ Continue'}
                </button>
              )}
              {detail.status === 'paused' && detail.pause_reason === 'awaiting-human-submit' && (
                <button
                  onClick={async () => {
                    try {
                      await api.post(`/automations/${detail.id}/complete`)
                      toast.success('Marked complete — tab closed')
                      setOpen(null); setDetail(null); load()
                    } catch { toast.error('Failed to complete') }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                >
                  ✔️ Submit done
                </button>
              )}
              {detail.status === 'running' && (
                <button onClick={pause} className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600">⏸ Pause</button>
              )}
              {['running', 'paused'].includes(detail.status) && (
                <button onClick={cancel} className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs font-semibold hover:bg-red-50">{cancelArmed ? 'Click again to cancel' : 'Cancel'}</button>
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

      {pickerFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
          onClick={() => setPickerFor(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  Choose an agent
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Which agent should run <b>{pickerFor.name}</b>?
                {pickerFor.latest?.status === 'done' && (
                  <span className="block mt-1 text-amber-600 dark:text-amber-400">
                    Already completed for this profile. Choosing an agent runs it again.
                  </span>
                )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerFor(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg leading-none shrink-0"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="mt-4 space-y-1.5 max-h-80 overflow-y-auto">
              {agents.length === 0 && (
                <p className="text-xs text-slate-400 py-4 text-center">Waiting for agents to start…</p>
              )}
              {agents.map(a => {
                const c = AGENT_COLOR[a.color?.key] || AGENT_COLOR.green
                const busy = a.state === 'working'
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => chooseAgent(pickerFor, a.laneId)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-left"
                  >
                    <span className={`w-3 h-3 rounded-full ${c.dot} ${busy ? 'animate-pulse' : ''}`} />
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{a.label}</span>
                    {a.assignment && (
                      <span className="px-1 rounded bg-slate-100 dark:bg-slate-800 text-[9px] uppercase tracking-wide text-slate-500">
                        {ASSIGN_LABEL[a.assignment]}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-slate-400 truncate max-w-[45%]">
                      {busy && a.current ? `busy · ${a.current.workflowId}` : 'idle'}
                    </span>
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              onClick={() => chooseAgent(pickerFor, null)}
              className="mt-3 w-full px-3 py-2 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700"
            >
              Automatic — any free agent
            </button>
          </div>
        </div>
      )}
    </section>
  )
}