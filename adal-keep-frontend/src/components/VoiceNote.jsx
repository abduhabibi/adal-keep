/**
 * A voice message, as Telegram shows it: a round play button, its waveform
 * (filled as it plays; tap it to jump) and the time. The note is downloaded
 * whole first: a recording from a phone (webm) says no length of its own, and
 * Android's player cannot jump around in a file streamed without ranges — that
 * is what showed "0:00 / 0:00" and played nothing.
 */
import { useEffect, useRef, useState } from 'react'

const BARS = 36
const clock = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export default function VoiceNote({ src, mine }) {
  const [url, setUrl] = useState(null)
  const [peaks, setPeaks] = useState(null)
  const [length, setLength] = useState(0)
  const [at, setAt] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const audio = useRef(null)

  useEffect(() => {
    let alive = true, made = null
    ;(async () => {
      try {
        // Through the API: on a phone it is the PC, or the chat server itself (cloud/chatDirect.js).
        let blob
        if (window.__ADAL_CLOUD && /^\/api\//.test(src)) {
          const u = new URL(src, location.origin)
          const { default: api } = await import('../services/api')
          blob = (await api.get(u.pathname.replace(/^\/api/, ''), { params: Object.fromEntries(u.searchParams), responseType: 'blob' })).data
        } else {
          const r = await fetch(src, { credentials: 'include' })
          if (!r.ok) throw new Error(String(r.status))
          blob = await r.blob()
        }
        made = URL.createObjectURL(blob)
        if (!alive) return
        setUrl(made)
        // Its length and waveform, read from the sound itself.
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext
          const ctx = new Ctx()
          const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
          ctx.close?.()
          const ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / BARS))
          const p = []
          for (let i = 0; i < BARS; i++) {
            let m = 0
            for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 16) m = Math.max(m, Math.abs(ch[j]))
            p.push(m)
          }
          const top = Math.max(...p, 0.01)
          if (alive) { setPeaks(p.map(v => 0.15 + 0.85 * (v / top))); setLength(buf.duration) }
        } catch { if (alive) setPeaks(Array.from({ length: BARS }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 1.7)))) }
      } catch { if (alive) setFailed(true) }
    })()
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [src])

  const toggle = (e) => {
    e?.stopPropagation()
    const a = audio.current
    if (!a) return
    if (a.paused) { document.querySelectorAll('audio[data-voice]').forEach(x => x !== a && x.pause()); a.play().catch(() => setFailed(true)) }
    else a.pause()
  }
  const seek = (e) => {
    e.stopPropagation()
    const a = audio.current, total = length || a?.duration
    if (!a || !total || !isFinite(total)) return
    const r = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.min(total, Math.max(0, ((e.clientX - r.left) / r.width) * total))
    setAt(a.currentTime)
  }

  const total = length || audio.current?.duration || 0
  const done = total ? at / total : 0
  const on = mine ? 'bg-[#4fae4e] dark:bg-sky-300' : 'bg-[#3390ec] dark:bg-sky-400'
  const off = mine ? 'bg-[#4fae4e]/35 dark:bg-sky-300/35' : 'bg-[#3390ec]/30 dark:bg-sky-400/30'
  return (
    <div data-no-swipe className="my-1 flex w-60 max-w-full items-center gap-2.5" onClick={e => e.stopPropagation()}>
      <button type="button" onClick={toggle} disabled={!url && !failed} title={playing ? 'Pause' : 'Play'}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow ${mine ? 'bg-[#4fae4e] dark:bg-sky-400' : 'bg-gradient-to-br from-[#4fa9f5] to-[#2b7fdc]'} disabled:opacity-60`}>
        {failed ? '!' : !url ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          : playing
            ? <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></svg>
            : <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" /></svg>}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex h-7 cursor-pointer items-center gap-[2px]" onClick={seek}>
          {(peaks || Array.from({ length: BARS }, () => 0.25)).map((h, i) => (
            <span key={i} className={`w-[3px] shrink-0 rounded-full ${i / BARS < done ? on : off}`} style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
        </div>
        <p className={`text-[11px] ${mine ? 'text-emerald-700 dark:text-sky-200/80' : 'text-slate-500'}`}>
          {failed ? 'Could not play' : clock(playing || at ? at : total)}
        </p>
      </div>
      {url && (
        <audio ref={audio} data-voice src={url} preload="auto" className="hidden"
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setAt(0) }}
          onTimeUpdate={e => setAt(e.currentTarget.currentTime)}
          onLoadedMetadata={e => { const d = e.currentTarget.duration; if (!length && isFinite(d)) setLength(d) }} />
      )}
    </div>
  )
}
