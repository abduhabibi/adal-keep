/**
 * Settings → Sign-in codes (main PC only): the Musaned authenticator key and
 * the phone that forwards LMIS SMS codes. See backend services/otp.js.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'
import jsQR from 'jsqr'
import QRCode from 'qrcode'

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
const err = (e) => e?.response?.data?.error || e.message

/** The text inside the first QR code found in a picture (Blob or data URL), or null. */
async function readQr(src) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    for (const scale of [1, 0.5, 2, 0.25]) {
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale)
      if (w < 50 || h < 50 || w * h > 16e6) continue
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d', { willReadFrequently: true })
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h)
      g.drawImage(img, 0, 0, w, h)
      const found = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })
      if (found?.data) return found.data
    }
    return null
  } finally { if (typeof src !== 'string') URL.revokeObjectURL(url) }
}

/** A QR code the phone camera opens. */
function Qr({ text }) {
  const [src, setSrc] = useState('')
  useEffect(() => { QRCode.toDataURL(text, { margin: 2, width: 220 }).then(setSrc).catch(() => setSrc('')) }, [text])
  return src ? <img src={src} alt="QR code for the phone" width={220} height={220} className="rounded-lg border border-slate-200 bg-white" /> : null
}

const fmtOffset = (s) => { const a = Math.abs(s); const h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60); return `${h ? `${h} h ` : ''}${m ? `${m} min` : h ? "" : `${a} s`}`.trim() + (s > 0 ? ' behind' : ' ahead') }

export default function SignInCodesCard() {
  const [c, setC] = useState(null)
  const [now, setNow] = useState(null)
  const [tab, setTab] = useState('android')
  const [reading, setReading] = useState(false)
  const [via, setVia] = useState(0)

  const saveKey = async (secret, ok = 'QR code saved. If Musaned is waiting for a code now, type the one shown here.') => {
    try { await api.post('/otp/totp', { secret }); toast.success(ok, { duration: 7000 }); load(); return true }
    catch (e) { toast.error(err(e), { duration: 9000 }); return false }
  }
  const fromPictures = async (pictures) => {
    setReading(true)
    try {
      for (const p of pictures) {
        const text = await readQr(p).catch(() => null)
        if (!text) continue
        if (!/^otpauth(-migration)?:\/\//i.test(text)) { toast.error('That QR code is not an authenticator QR code.'); return }
        await saveKey(text)
        return
      }
      toast.error('No QR code found in it. Make the QR code bigger on the screen (zoom in), take the picture again.', { duration: 8000 })
    } finally { setReading(false) }
  }
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile())
    if (files.length) { e.preventDefault(); fromPictures(files) }
  }

  const load = () => api.get('/otp').then(r => setC(r.data)).catch(() => setC(false))
  useEffect(() => { load() }, [])
  // The SMS status refreshes while the card is open (to see the phone's test message arrive).
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t) }, [])
  useEffect(() => {
    if (!c?.musaned_totp) { setNow(null); return }
    const tick = () => api.get('/otp/totp/now').then(r => setNow(r.data)).catch(() => {})
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [c?.musaned_totp])

  if (!c) return null // not the main PC itself
  const pages = [
    ...(c.phone_pages?.office || []).map(u => ({ u, label: 'Phone on the office Wi-Fi' })),
    ...(c.phone_pages?.tailscale ? [{ u: c.phone_pages.tailscale, label: 'Phone with Tailscale (Wi-Fi or mobile data)' }] : []),
  ]
  const page = pages[Math.min(via, Math.max(0, pages.length - 1))]
  const seen = c.sms?.phone_seen_at

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🔑</span> Sign-in codes</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        Adal Keep types the Musaned authenticator code and the LMIS SMS code by itself — during runs and when you sign in by hand
        in the Adal Keep browser. The Musaned “I'm not a robot” is still answered by a person.
      </p>

      <section className="mb-5" translate="no">
        <h3 className="font-semibold">Musaned — authenticator {c.musaned_totp && <span className="text-teal-600">✓ set up</span>}</h3>
        <p className="text-sm text-slate-500 my-2">
          Upload the picture of Musaned's authenticator QR code. Then Adal Keep types the Musaned code by itself every time.
        </p>
        <label tabIndex={0} onPaste={onPaste} onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = [...e.dataTransfer.files].filter(x => x.type.startsWith('image/')); if (f.length) fromPictures(f) }}
          className="block cursor-pointer rounded-xl border-2 border-dashed border-teal-400 bg-teal-50/50 dark:bg-teal-900/10 px-4 py-6 text-center hover:bg-teal-50 dark:hover:bg-teal-900/20 focus:outline-none focus:border-teal-600">
          <span className="block text-3xl">📷</span>
          <span className="block font-semibold mt-1">{reading ? 'Reading the QR code…' : c.musaned_totp ? 'Upload a new QR code' : 'Upload the QR code'}</span>
          <span className="block text-xs text-slate-500 mt-1">Click to choose the picture — or drop it here, or paste it (Ctrl + V)</span>
          <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromPictures([f]) }} />
        </label>
        {now && (
          <div className="mt-2 flex items-center gap-3 text-sm">
            <span>Code now:</span>
            <span className="font-mono text-2xl tracking-widest">{now.code.slice(0, 3)} {now.code.slice(3)}</span>
            <span className="text-xs text-slate-500">{now.seconds_left}s</span>
            {c.here && <button type="button" className="ml-auto text-xs text-red-600 hover:underline" onClick={async () => {
              if (!confirm('Remove the Musaned authenticator key from Adal Keep?')) return
              await api.delete('/otp/totp'); load()
            }}>Remove</button>}
          </div>
        )}
        {now?.clock && Math.abs(now.clock.offset_s) >= 10 && (
          <p className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            ⏰ The main PC's clock is {fmtOffset(now.clock.offset_s)}. Adal Keep corrects it for the codes; also fix it in
            Windows: Settings → Time &amp; language → Date &amp; time → <b>Set time automatically</b> and the right time zone (Nairobi, UTC+3).
          </p>
        )}
        {now && (
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer">Musaned says the code is wrong?</summary>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>Adal Keep tries every authenticator device Musaned lists (“Adal Keep” first) and the next code, by itself.</li>
              <li>The QR code must be the one that was finished on Musaned (its code typed and saved). A QR picture from a setup page that was closed or reloaded is not known to Musaned — then remove the authenticator in Musaned, sign in again in the Adal Keep browser, and Adal Keep reads the new QR code by itself.</li>
            </ul>
          </details>
        )}
      </section>

      <section translate="no">
        <h3 className="font-semibold">LMIS — SMS codes from a phone</h3>
        <div className={`my-2 rounded-lg px-3 py-2 text-sm ${seen ? 'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
          {seen ? <>📱 <b>Phone connected</b> — last heard {new Date(seen).toLocaleString()}</> : <>📱 No phone connected yet — do step 1.</>}
          {c.sms?.last_at && <> · last SMS {new Date(c.sms.last_at).toLocaleString()}{c.sms.last_from ? ` from ${c.sms.last_from}` : ''}</>}
        </div>
        <p className="text-sm text-slate-500 mb-3">
          Use the phone with the SIM that gets the LMIS codes. It stays in the office, charging, with internet. Each SMS it gets is sent to the main PC, which types the code into LMIS.
        </p>

        <p className="font-semibold text-sm">Step 1 — connect the phone (1 minute)</p>
        <div className="flex flex-wrap gap-4 items-start mt-1">
          {page ? <Qr text={page.u} /> : <p className="text-sm text-red-600">The main PC has no Wi-Fi/network address yet — connect it to the office Wi-Fi, then reopen Settings.</p>}
          <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300 space-y-1 flex-1 min-w-[220px]">
            <li>Put the phone on the <b>office Wi-Fi</b> (the same one as the main PC).</li>
            <li>Open the phone's <b>camera</b>, point it at this QR code and tap the link that appears.</li>
            <li>The phone shows <b>“✅ This phone reaches Adal Keep”</b> and this card turns green: <b>Phone connected</b>.</li>
            <li>Keep that page open — step 2 copies the link from it.</li>
          </ol>
        </div>
        {pages.length > 1 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {pages.map((p, n) => (
              <button key={p.u} type="button" onClick={() => setVia(n)}
                className={`rounded-lg px-2 py-1 text-xs border ${n === via ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-300 dark:border-slate-600'}`}>{p.label}{p.u.includes('//100.') ? '' : ` · ${new URL(p.u).hostname}`}</button>
            ))}
          </div>
        )}
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-300">The page does not open on the phone?</summary>
          <ul className="list-disc pl-5 mt-1 text-slate-500 space-y-0.5">
            <li>The phone must be on the same Wi-Fi as this PC — not mobile data, not a guest Wi-Fi.</li>
            <li>Try the other address button above the QR code (if there is one).</li>
            <li>Run “2 - Install Adal Main.exe” from the USB once on this PC: it opens the Windows firewall for Adal Keep.</li>
            <li>For mobile data: install Tailscale on the phone, sign in with the agency Google account, then use the Tailscale button.</li>
          </ul>
        </details>

        <p className="font-semibold text-sm mt-4">Step 2 — the SMS app</p>
        <div className="flex gap-2 my-1">
          {['android', 'iphone'].map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1 text-sm border ${tab === t ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-300 dark:border-slate-600'}`}>
              {t === 'android' ? 'Android' : 'iPhone'}
            </button>
          ))}
        </div>
        {tab === 'android' ? (
          <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300 space-y-1">
            <li>Play Store → search <b>“SMS to URL Forwarder”</b> → Install → Open. Allow it to <b>read SMS</b> and send notifications.</li>
            <li>On the page from step 1 press <b>Copy the link</b>.</li>
            <li>In the app press <b>+</b>. <b>Sender</b>: <code>*</code> (every sender). <b>URL</b>: paste the link. Leave the rest as it is. Press <b>Save</b>.</li>
            <li>Phone Settings → Apps → SMS to URL Forwarder → Battery → <b>Unrestricted</b> (so Android never stops it).</li>
          </ol>
        ) : (
          <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300 space-y-1">
            <li>On the page from step 1 press <b>Copy the link</b>.</li>
            <li>Open <b>Shortcuts</b> → <b>Automation</b> → <b>+</b> → <b>Message</b> → “Message contains”: <code>code</code> (or choose the LMIS sender) → <b>Run Immediately</b> → Next.</li>
            <li>New blank automation → add action <b>Get Contents of URL</b>. URL: paste the link. Tap ▸: Method <b>POST</b>, Request Body <b>JSON</b>, add field <code>text</code> → value: <b>Shortcut Input</b> (Message). Done.</li>
          </ol>
        )}

        <p className="font-semibold text-sm mt-4">Step 3 — test</p>
        <p className="text-sm text-slate-600 dark:text-slate-300">From another phone, send this phone an SMS (any text). Within a few seconds “last SMS” above shows it. Done — LMIS codes now arrive the same way.</p>

        {c.here && <button type="button" className="mt-3 text-xs text-slate-500 hover:underline" onClick={async () => {
          if (!confirm('Make a new link? The phone must scan the new QR code again; the old link stops working.')) return
          await api.post('/otp/sms-key'); load()
        }}>Phone lost or changed? Make a new link</button>}
      </section>
    </Card>
  )
}
