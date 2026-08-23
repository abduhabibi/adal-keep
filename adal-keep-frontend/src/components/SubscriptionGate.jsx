import { useState, useEffect } from 'react'
import api from '../services/api'

// Inline fingerprint — no external dependency
function getFingerprint() {
  try {
    const raw = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone
    ].join('|')
    let hash = 0
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash) + raw.charCodeAt(i)
      hash |= 0
    }
    return 'web-' + Math.abs(hash).toString(36)
  } catch {
    return 'web-unknown-' + Date.now()
  }
}

export default function SubscriptionGate({ children }) {
  const [status, setStatus] = useState('checking')
  const [daysRemaining, setDaysRemaining] = useState(0)
  const [paymentRef, setPaymentRef] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('telebirr')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const fp = getFingerprint()
        const res = await api.get(`/subscription/status?fingerprint=${fp}`)
        if (!cancelled) {
          setStatus(res.data.status)
          setDaysRemaining(res.data.days_remaining || 0)
        }
      } catch {
        if (!cancelled) {
          // Offline or server down — allow access, don't block
          setStatus('active')
        }
      }
    }
    check()
    const interval = setInterval(check, 300000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const activateTrial = async () => {
    try {
      const fp = getFingerprint()
      const res = await api.post('/subscription/activate-trial', {
        fingerprint: fp,
        client_name: 'New Client'
      })
      setStatus(res.data.status)
      setDaysRemaining(res.data.days_remaining)
    } catch {
      setMessage('ሙከራ ማስጀመር አልተቻለም። እባክዎ ኔትወርክ ያረጋግጡ።')
    }
  }

  const submitPayment = async () => {
    if (!paymentRef.trim()) return
    setSubmitting(true)
    try {
      const fp = getFingerprint()
      const res = await api.post('/subscription/submit-payment', {
        fingerprint: fp,
        payment_ref: paymentRef.trim(),
        method: paymentMethod
      })
      setMessage(res.data.message)
      setStatus('pending_approval')
    } catch {
      setMessage('ክፍያ ማስገባት አልተቻለም')
    } finally {
      setSubmitting(false)
    }
  }

  // ✅ FAIL-SAFE: If anything goes wrong, ALWAYS show the app
  if (status === 'checking') {
    return <div className="min-h-screen flex items-center justify-center text-white/50 text-sm">በመጫን ላይ...</div>
  }

  // Active, trial, offline, or unknown — show the app
  if (status === 'active' || status === 'trial' || status === 'offline' || status === 'not_found') {
    return (
      <>
        {status === 'trial' && daysRemaining <= 7 && (
          <div className="fixed top-0 left-0 right-0 bg-yellow-500/90 text-black text-center py-1.5 text-xs font-semibold z-[100]">
            ⚠️ የሙከራ ጊዜዎ በ{daysRemaining} ቀናት ውስጥ ያበቃል
          </div>
        )}
        {children}
      </>
    )
  }

  // Pending approval
  if (status === 'pending_approval') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--bg)]">
        <div className="glass-panel max-w-md w-full p-8 text-center space-y-4">
          <div className="text-4xl">⏳</div>
          <h2 className="text-xl font-bold">ክፍያዎ በማረጋገጫ ላይ</h2>
          <p className="text-sm text-white/60">አስተዳዳሪ ክፍያዎን ካረጋገጠ በኋላ ስርዓቱ ይከፈታል።</p>
          <button onClick={() => window.location.reload()} className="text-teal-400 text-sm hover:underline">
            ሁኔታን ያረጋግጡ ↻
          </button>
        </div>
      </div>
    )
  }

  // Expired or locked — payment screen
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--bg)]">
      <div className="glass-panel max-w-lg w-full p-8 space-y-6">
        <div className="text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-2xl font-bold font-display mb-2">
            {status === 'expired' ? 'ደንበኝነት ምዝገባ አልቋል' : 'እንኳን ደህና መጡ'}
          </h1>
          <p className="text-sm text-white/60">
            {status === 'expired'
              ? 'ለመቀጠል እባክዎ ያድሱ።'
              : 'የ30 ቀን ነፃ ሙከራ ይጀምሩ።'}
          </p>
        </div>

        {status !== 'expired' && (
          <button onClick={activateTrial} className="w-full py-3 bg-teal-500 hover:bg-teal-400 text-white rounded-xl font-semibold transition-all">
            🎁 የ30 ቀን ነፃ ሙከራ ጀምር
          </button>
        )}

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-xs text-white/30">ወይም</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {['telebirr', 'cbe'].map(m => (
              <button key={m} onClick={() => setPaymentMethod(m)}
                className={`py-2.5 rounded-lg text-sm font-medium border transition-all ${
                  paymentMethod === m ? 'border-teal-500 bg-teal-500/10 text-teal-400' : 'border-white/10 text-white/50'
                }`}>
                {m === 'telebirr' ? '📱 telebirr' : '🏦 CBE Birr'}
              </button>
            ))}
          </div>

          <div className="bg-white/5 rounded-lg p-3 text-xs text-white/50">
            <p>📲 telebirr: *127# → Adal Software → ብር 500</p>
            <p>🏦 CBE: ወደ 1000XXXXXX ይላኩ → ብር 500</p>
          </div>

          <input type="text" value={paymentRef} onChange={e => setPaymentRef(e.target.value)}
            placeholder="የክፍያ ማጣቀሻ ቁጥር (TXN...)" className="field text-sm" />

          <button onClick={submitPayment} disabled={!paymentRef.trim() || submitting}
            className="w-full py-3 bg-gradient-to-r from-teal-500 to-teal-600 text-white rounded-xl font-semibold transition-all disabled:opacity-50">
            {submitting ? 'በማስገባት ላይ...' : 'ክፍያ አረጋግጥ'}
          </button>

          {message && <p className="text-center text-sm text-teal-400">{message}</p>}
        </div>
      </div>
    </div>
  )
}