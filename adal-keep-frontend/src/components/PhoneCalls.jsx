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

export default function PhoneCalls() {
  const navigate = useNavigate()
  const last = useRef(0)
  useEffect(() => {
    if (!IN_PHONE_APP) return
    let alive = true, timer = null
    const tick = async () => {
      try {
        const { data } = await api.get('/tasks/calls', { params: { after: last.current } })
        if (last.current === 0) last.current = data[0]?.id || -1
        else {
          for (const c of [...data].reverse()) {
            last.current = Math.max(last.current, c.id)
            ring(/captcha|code|robot|sign-in|sign in|reCAPTCHA/i.test(c.title))
            toast((t) => (
              <button type="button" className="text-left" onClick={() => { toast.dismiss(t.id); if (c.profile_id) navigate(`/profiles/${c.profile_id}?attention=1`) }}>
                <b className="block text-sm">{c.title}</b>
                <span className="block text-xs text-slate-500 mt-0.5">{c.description?.slice(0, 140)}</span>
                <span className="block text-xs text-teal-700 font-semibold mt-1">Tap to open →</span>
              </button>
            ), { duration: 20000 })
          }
        }
      } catch {}
      if (alive) timer = setTimeout(tick, 6000)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [navigate])
  return null
}
