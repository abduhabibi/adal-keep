/**
 * Which PC is doing a run (robots on every PC, 2026-11-27): "on DESK-2" beside a working run,
 * from GET /api/run-claims (services/runClaims.js). Nothing shows when it is unknown or the
 * claims are off; anything wrong in it shows nothing.
 */
import { Component, useEffect, useState } from 'react'
import api from '../services/api'

function OnPc({ runId }) {
  const [c, setC] = useState(null)
  useEffect(() => {
    let live = true
    const look = () => api.get('/run-claims').then(r => { if (live) setC((r.data || []).find(x => Number(x.run_id) === Number(runId)) || null) }).catch(() => {})
    look()
    const t = setInterval(() => { if (!document.hidden) look() }, 10000)
    return () => { live = false; clearInterval(t) }
  }, [runId])
  if (!c) return null
  return <span className="block text-[10px] text-slate-500" data-run-pc={c.pc_name} translate="no">{c.here ? 'on this PC' : `on ${c.pc_name}`}</span>
}

export default class RunOnPc extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[run on pc]', e) }
  render() { return this.state.bad ? null : <OnPc {...this.props} /> }
}
