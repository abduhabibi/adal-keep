import { useEffect } from 'react'
import api from '../services/api'

/**
 * A chime when an LMIS police certificate run finishes (ready for Submit).
 * Runs already waiting when the page opens do not chime.
 */
let audio = null
function ctx() {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  audio ||= new AC()
  if (audio.state === 'suspended') audio.resume().catch(() => {})
  return audio
}

export function playChime() {
  const a = ctx()
  if (!a) return
  const t = a.currentTime
  // Three rising notes, soft attack and fade.
  ;[[784, 0], [988, 0.16], [1319, 0.32]].forEach(([f, d]) => {
    const o = a.createOscillator(), g = a.createGain()
    o.type = 'sine'; o.frequency.value = f
    g.gain.setValueAtTime(0.0001, t + d)
    g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6)
    o.connect(g).connect(a.destination)
    o.start(t + d); o.stop(t + d + 0.65)
  })
}

export default function useReadyChime() {
  useEffect(() => {
    // Browsers only allow sound after the person has clicked or typed once.
    const unlock = () => ctx()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })

    let seen = null
    let stop = false
    const check = async () => {
      try {
        const { data } = await api.get('/automations/ready-for-submit')
        const ids = new Set((data || []).map(r => `${r.id}@${r.updated_at}`))
        if (seen && [...ids].some(k => !seen.has(k))) playChime()
        seen = ids
      } catch {}
    }
    check()
    const timer = setInterval(() => { if (!stop) check() }, 8000)
    return () => {
      stop = true
      clearInterval(timer)
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])
}
