import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import api from '../services/api'

/**
 * The paywall. After the 14-day trial the server refuses everything until
 * this PC is unlocked; this screen is all that shows. During the trial the
 * same screen opens from the banner (with a close button).
 *
 * Unlock: pay with the QR → call the seller, say the PC number → type the
 * 6-digit Google Authenticator code they read out.
 */
const CAPABILITIES = [
  'reads every passport for you — and checks every digit.',
  'files each document into the right profile, by itself.',
  'fills the LMIS police clearance form from start to finish.',
  'registers candidates on Musaned — photo, skills and experience.',
  'runs many automations at once, each in its own tab.',
  'keeps brokers, profiles and payments in one place.',
  'lets your whole team work from every PC in the office.',
  'keeps all your data on your own computer.',
]

/** The full list, shown under the payment: what the customer gets. */
const FEATURES = [
  { icon: '🛂', ai: true,  title: 'Reads every passport',     text: 'Name, number, dates and place of birth — every digit checked against the passport strip.' },
  { icon: '🗂️', ai: true,  title: 'Files documents by itself', text: 'Drop in scans and photos: each one is recognised and put in the right worker’s profile.' },
  { icon: '🚓', ai: false, title: 'Police clearance on LMIS',  text: 'Logs in, fills the request, uploads slip, passport and photo — then calls you to press Submit.' },
  { icon: '🔍', ai: true,  title: 'Checks its own work',      text: 'Looks over every finished form before you see it, and redoes anything that did not stick.' },
  { icon: '🇸🇦', ai: false, title: 'Musaned registration',     text: 'Registers candidates with their photo, skills and experience filled in.' },
  { icon: '📄', ai: false, title: 'CVs in one click',          text: 'Each worker’s CV in your agency’s own design, ready as a PDF.' },
  { icon: '⚡', ai: false, title: 'Many jobs at once',          text: 'Every run works in its own tab in the background while you keep working.' },
  { icon: '🔔', ai: false, title: 'Tells you when it is done', text: 'A chime and a notification the moment a form is ready for you.' },
  { icon: '👥', ai: false, title: 'Your whole office',         text: 'Every PC in the office works on the same profiles, brokers and payments.' },
  { icon: '🔒', ai: false, title: 'Your data stays yours',     text: 'Everything is kept on your own computer, not on someone else’s server.' },
]

function Features() {
  return (
    <section className="md:col-span-2 border-t border-white/10 pt-6" aria-labelledby="lock-features-title">
      <h2 id="lock-features-title" className="text-lg sm:text-xl font-bold text-white">
        Everything <span className="lock-grad-text">Adal Keep</span> does for you
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {FEATURES.map((f, i) => (
          <li key={f.title} className="lock-feature" style={{ animationDelay: `${i * 70}ms` }}>
            <div className="flex items-center justify-between">
              <span className="text-2xl" aria-hidden="true">{f.icon}</span>
              {f.ai && <span className="lock-ai">AI</span>}
            </div>
            <h3 className="mt-2 text-sm font-bold text-white">{f.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">{f.text}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Typewriter({ items }) {
  const [text, setText] = useState('')
  const [reduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (reduced) return
    let alive = true
    let i = 0
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    ;(async () => {
      while (alive) {
        const line = items[i % items.length]
        for (let n = 1; n <= line.length && alive; n++) { setText(line.slice(0, n)); await wait(28 + Math.random() * 40) }
        await wait(1700)
        for (let n = line.length; n >= 0 && alive; n--) { setText(line.slice(0, n)); await wait(14) }
        await wait(350)
        i++
      }
    })()
    return () => { alive = false }
  }, [items, reduced])

  if (reduced) {
    return <ul className="space-y-1 text-base text-slate-200">{items.map(t => <li key={t}>Adal Keep {t}</li>)}</ul>
  }
  return (
    <p className="min-h-[4.5rem] text-xl sm:text-2xl leading-snug font-medium text-slate-100">
      <span className="lock-grad-text font-bold">Adal Keep </span>
      {text}
      <span className="lock-caret" aria-hidden="true" />
    </p>
  )
}

export default function LockScreen({ onClose }) {
  const { subscription } = useAuth()
  const [paid, setPaid] = useState(false)
  const [code, setCode] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const inputRef = useRef(null)

  const pc = subscription?.pcNumber || '------'
  const phone = subscription?.sellerPhone || '0995668080'
  const locked = subscription?.mode === 'locked'

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t) }, [])
  useEffect(() => { if (paid) inputRef.current?.focus() }, [paid])

  const submit = async (e) => {
    e.preventDefault()
    if (code.length !== 6) { setError('The code has 6 digits.'); return }
    setBusy(true); setError('')
    try {
      // Straight to the server (not the auth refresh): the thank-you shows, then the app opens.
      await api.post('/subscription/unlock', { code })
      setDone(true)
      setTimeout(() => window.location.reload(), 1400)
    } catch (err) {
      setError(err.response?.data?.error || 'That code did not work. Ask for a new one.')
      setCode('')
    } finally { setBusy(false) }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(pc); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <div className="lock-screen fixed inset-0 z-[10000] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Unlock Adal Keep">
      <div className="lock-backdrop" aria-hidden="true"><span /><span /><span /></div>

      <div className="relative min-h-full flex items-center justify-center px-4 py-8">
        <div className="lock-frame w-full max-w-5xl">
          <div className="lock-card grid gap-8 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] p-5 sm:p-8">
            {onClose && (
              <button type="button" onClick={onClose} aria-label="Close"
                className="absolute right-4 top-4 h-9 w-9 rounded-full bg-white/10 text-white hover:bg-white/20">✕</button>
            )}

            {/* Pay */}
            <div className="flex flex-col items-center gap-3">
              <div className="lock-glow w-full max-w-sm rounded-3xl p-[3px]">
                <img src="/adal-payment.webp" alt="Pay 50,000 ETB to Commercial Bank of Ethiopia account 1000709131323 — Adal Keep Subscription"
                  className="block w-full rounded-[21px]" />
              </div>
              <p className="text-sm text-slate-400 text-center">Scan with your CBE app to pay</p>
              <p className="w-full max-w-sm rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-center text-sm text-emerald-100">
                <span aria-hidden="true">💚 </span>
                <strong className="text-emerald-300">10% of your payment goes to charity</strong>
                <span className="block text-xs text-emerald-200/80 mt-0.5">5,000 ETB of the 50,000 ETB</span>
              </p>
            </div>

            {/* Tell */}
            <div className="flex flex-col gap-5 min-w-0">
              <div>
                <span className="lock-pill">
                  {locked
                    ? (subscription?.clockBack ? 'This PC\'s clock was set back — Adal Keep is locked' : `Your ${subscription?.trialDays || 14}-day free trial has ended`)
                    : `${subscription?.daysLeft ?? ''} day${subscription?.daysLeft === 1 ? '' : 's'} left in your free trial`}
                </span>
                <h1 className="lock-grad-text lock-flow mt-4 text-4xl sm:text-5xl font-extrabold tracking-tight">Unlock Adal Keep</h1>
              </div>

              <Typewriter items={CAPABILITIES} />

              <ol className="space-y-3 text-sm text-slate-300">
                <li className="flex gap-3"><span className="lock-step">1</span><span>Pay with the QR code.</span></li>
                <li className="flex gap-3">
                  <span className="lock-step">2</span>
                  <span className="min-w-0">
                    Call <a href={`tel:${phone}`} className="lock-grad-text font-bold text-base">{phone}</a> and tell them this number:
                    <span className="mt-2 flex items-center gap-3">
                      <span className="lock-grad-text font-mono text-4xl font-extrabold tracking-[0.25em]">{pc}</span>
                      <button type="button" onClick={copy} className="rounded-lg bg-white/10 px-2.5 py-1 text-xs text-white hover:bg-white/20">
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </span>
                  </span>
                </li>
                <li className="flex gap-3"><span className="lock-step">3</span><span>They give you a 6-digit code. Press <b className="text-white">I have paid</b> and type it.</span></li>
              </ol>

              {done ? (
                <div className="lock-button text-center">Unlocked — thank you! Opening Adal Keep…</div>
              ) : !paid ? (
                <button type="button" onClick={() => setPaid(true)} className="lock-button">I have paid</button>
              ) : (
                <form onSubmit={submit} className="space-y-3">
                  <div className="lock-frame">
                    <div className="flex items-center rounded-[14px] bg-slate-950/90">
                      <input
                        ref={inputRef}
                        type={show ? 'text' : 'password'}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={code}
                        onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
                        placeholder="••••••"
                        aria-label="Unlock code"
                        className="min-w-0 flex-1 bg-transparent px-4 py-3 text-center font-mono text-3xl tracking-[0.5em] text-white placeholder:text-slate-600 focus:outline-none"
                      />
                      <button type="button" onClick={() => setShow(s => !s)} className="px-4 text-xs text-slate-400 hover:text-white">
                        {show ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                  {error && <p className="text-sm text-rose-300">{error}</p>}
                  <button type="submit" disabled={busy || code.length !== 6} className="lock-button disabled:opacity-50">
                    {busy ? 'Checking…' : 'Unlock Adal Keep'}
                  </button>
                  <p className="text-xs text-slate-500">
                    This PC's time: {now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. The code only works when it is right.
                  </p>
                </form>
              )}
            </div>

            <Features />
          </div>
        </div>
      </div>
    </div>
  )
}
