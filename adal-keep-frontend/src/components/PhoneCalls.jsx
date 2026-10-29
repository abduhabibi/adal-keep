import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { IN_PHONE_APP } from '../lib/phoneApp'

/**
 * In the phone app: when a run calls for a person (captcha, code, Submit…),
 * the phone rings and shows the call; a tap opens her profile's AI actions,
 * where the PC's tab shows live. Sign-in calls beep like the PC's watch alarm.
 */
function ring(signIn) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const beep = (t, f, d) => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination)
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t)
      g.gain.exponentialRampToValueAtTime(0.6, ctx.currentTime + t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + d)
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + d + 0.05)
    }
    if (signIn) for (let r = 0; r < 5; r++) for (let b = 0; b < 4; b++) beep(r * 1 + b * 0.13, 2800, 0.07)
    else [[0, 660], [0.2, 880], [0.4, 1100]].forEach(([t, f]) => beep(t, f, 0.25))
    setTimeout(() => ctx.close(), 6000)
  } catch {}
  try { navigator.vibrate?.([300, 150, 300, 150, 300]) } catch {}
}

const FRESH = 3 * 60 * 1000      // only what is happening now: older calls are not shown

export default function PhoneCalls() {
  const navigate = useNavigate()
  const last = useRef(0)
  const shown = useRef(new Set())
  useEffect(() => {
    if (!IN_PHONE_APP && !window.__ADAL_CLOUD) return
    let alive = true, timer = null, off = null
    // One call on screen at a time (the newest), gone by itself after 10 s.
    const show = (c) => {
      if (!c?.id || shown.current.has(c.id)) return
      shown.current.add(c.id)
      last.current = Math.max(last.current, c.id)
      const at = c.at || new Date(c.created_at).getTime()
      if (!(Date.now() - at < FRESH)) return
      ring(/captcha|code|robot|sign-in|sign in|reCAPTCHA/i.test(c.title))
      const open = () => {
        toast.dismiss('phone-call')
        if (c.profile_id) navigate(`/profiles/${c.profile_id}?${c.run ? `run=${c.run}` : 'attention=1'}&t=${Date.now()}`)
        else navigate('/tasks')
      }
      toast((t) => (
        <button type="button" className="text-left w-full" onClick={open}>
          <b className="block text-sm">{c.title}</b>
          <span className="block text-xs text-slate-500 mt-0.5">{c.description?.slice(0, 140)}</span>
          <span className="block text-xs text-teal-700 font-semibold mt-1">Tap to open →</span>
        </button>
      ), { id: 'phone-call', duration: 10000 })
    }
    // At once from the PC (live link) …
    if (window.__ADAL_CLOUD) import('../cloud/live.js').then(L => { if (alive) off = L.onLive(m => { if (m.t === 'ring') show(m) }) })
    // … and a look now and then, for calls the live link missed.
    const tick = async () => {
      try {
        const { data } = await api.get('/tasks/calls', { params: { after: last.current } })
        if (last.current === 0) { last.current = data[0]?.id || -1; (data || []).forEach(c => shown.current.add(c.id)) }
        else for (const c of [...data].reverse()) show(c)
      } catch {}
      if (alive) timer = setTimeout(tick, document.hidden ? 30000 : 8000)
    }
    tick()
    return () => { alive = false; clearTimeout(timer); off?.() }
  }, [navigate])
  return null
}
