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

function Copy({ text }) {
  return (
    <div className="flex gap-2 items-center">
      <code className="flex-1 min-w-0 truncate rounded bg-slate-100 dark:bg-slate-900 px-2 py-1 text-xs">{text}</code>
      <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success('Copied'))}>Copy</Button>
    </div>
  )
}

export default function SignInCodesCard() {
  const [c, setC] = useState(null)
  const [key, setKey] = useState('')
  const [now, setNow] = useState(null)
  const [tab, setTab] = useState('android')
  const [reading, setReading] = useState(false)

  const saveKey = async (secret, ok = 'Saved — now type the code below into Musaned') => {
    try { await api.post('/otp/totp', { secret }); setKey(''); toast.success(ok, { duration: 7000 }); load(); return true }
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
  const fromMusanedTab = async () => {
    setReading(true)
    try {
      const r = (await api.get('/otp/musaned-tab-shots')).data
      if (!r.shots?.length) { toast.error(r.why || 'No Musaned tab found.', { duration: 8000 }); return }
      await fromPictures(r.shots.map(b => `data:image/png;base64,${b}`))
    } catch (e) { toast.error(err(e)) } finally { setReading(false) }
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
  const urls = [...(c.sms_urls?.office || []), ...(c.sms_urls?.tailscale ? [c.sms_urls.tailscale] : [])]
  const phoneUrl = c.sms_urls?.tailscale || c.sms_urls?.office?.[0] || ''

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🔑</span> Sign-in codes</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        Adal Keep types the Musaned authenticator code and the LMIS SMS code by itself — during runs and when you sign in by hand
        in the Adal Keep browser. The Musaned “I'm not a robot” is still answered by a person.
      </p>

      <section className="mb-5" translate="no">
        <h3 className="font-semibold">Musaned — authenticator {c.musaned_totp && <span className="text-teal-600">✓ set up</span>}</h3>
        <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300 space-y-1 my-2">
          <li>Open Musaned until it shows the <b>QR code</b> for the authenticator. Do not finish that page yet.</li>
          <li>Musaned open in the Adal Keep browser? Press <b>Read the QR from Musaned</b>. Somewhere else (another browser, a phone)? Take a picture of the QR code — on Windows <b>Windows + Shift + S</b> — and press <b>Ctrl + V</b> in the box below, or choose the picture.</li>
          <li>Also scan the same QR code with the phone app (Google or Microsoft Authenticator), so the phone works too.</li>
          <li>Type the <b>code shown below</b> into Musaned's box under the QR code and finish. From now on Adal Keep types it by itself.</li>
        </ol>
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" disabled={reading} onClick={fromMusanedTab}>{reading ? 'Reading…' : 'Read the QR from Musaned'}</Button>
          <label className="cursor-pointer rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
            Choose a picture
            <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromPictures([f]) }} />
          </label>
        </div>
        <div tabIndex={0} onPaste={onPaste} onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = [...e.dataTransfer.files].filter(x => x.type.startsWith('image/')); if (f.length) fromPictures(f) }}
          className="mt-2 rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-600 px-3 py-4 text-center text-sm text-slate-500 focus:border-teal-500 focus:outline-none">
          Click here, then press <b>Ctrl + V</b> to paste the picture of the QR code (or drop it here)
        </div>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-slate-500">Have the key as text instead?</summary>
          <div className="flex gap-2 mt-2">
            <input className={field} type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off"
              placeholder={c.musaned_totp ? 'Saved — paste a new key to change it' : 'Authenticator key or otpauth:// link'} />
            <Button size="sm" disabled={!key.trim()} onClick={() => saveKey(key)}>Save</Button>
          </div>
        </details>
        <p className="text-xs text-slate-500 mt-1">Phone already set up and Musaned shows no QR code any more? In Google Authenticator: menu → Transfer accounts → Export → choose Musaned; take a picture of that QR code and paste it here.</p>
        {now && (
          <div className="mt-2 flex items-center gap-3 text-sm">
            <span>Code now:</span>
            <span className="font-mono text-2xl tracking-widest">{now.code.slice(0, 3)} {now.code.slice(3)}</span>
            <span className="text-xs text-slate-500">{now.seconds_left}s</span>
            <button type="button" className="ml-auto text-xs text-red-600 hover:underline" onClick={async () => {
              if (!confirm('Remove the Musaned authenticator key from Adal Keep?')) return
              await api.delete('/otp/totp'); load()
            }}>Remove</button>
          </div>
        )}
      </section>

      <section translate="no">
        <h3 className="font-semibold">LMIS — SMS codes from a phone {c.sms?.count > 0 && <span className="text-teal-600">✓ messages arriving</span>}</h3>
        <p className="text-sm text-slate-500 my-2">
          The phone with the SIM that gets the LMIS codes stays in the office, charging, with internet (Wi-Fi or mobile data).
          Each SMS it gets is sent to this PC, which types the code into LMIS. With Tailscale on the phone it works on mobile data too.
        </p>
        <div className="flex gap-2 mb-2">
          {['android', 'iphone'].map(t => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1 text-sm border ${tab === t ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-300 dark:border-slate-600'}`}>
              {t === 'android' ? 'Android' : 'iPhone'}
            </button>
          ))}
        </div>
        {tab === 'android' ? (
          <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300 space-y-1">
            <li>Play Store → install <b>“SMS to URL Forwarder”</b> (by Konstantin Bogomolov, free, no account). Allow it to read SMS.</li>
            <li>Press <b>+</b>. Sender: <b>*</b> (or the LMIS sender name once you have seen one). URL: the link below.</li>
            <li>JSON template: <code>{'{"from":"%from%","text":"%text%"}'}</code> — keep it as the app shows it.</li>
            <li>Phone Settings → Apps → SMS to URL Forwarder → Battery → <b>Unrestricted</b>, so Android never stops it.</li>
            <li>Send the phone any SMS with a number in it (e.g. “test 1234”): “Last message” below changes.</li>
          </ol>
        ) : (
          <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300 space-y-1">
            <li>Open <b>Shortcuts</b> → Automation → <b>+</b> → <b>Message</b>. Sender: the LMIS sender (after the first LMIS SMS), or “Message contains: code”. Choose <b>Run Immediately</b>.</li>
            <li>Add the action <b>Get Contents of URL</b>: the link below, Method <b>POST</b>, Request Body <b>JSON</b>, field <code>text</code> = <b>Shortcut Input</b> (the message).</li>
            <li>Send the phone an SMS with a number in it: “Last message” below changes.</li>
          </ol>
        )}
        <div className="mt-3 space-y-1">
          <p className="text-xs text-slate-500">Link for the phone ({c.sms_urls?.tailscale ? 'the Tailscale one works on Wi-Fi and mobile data' : 'office Wi-Fi only — install Tailscale on the phone for mobile data'}):</p>
          {phoneUrl ? <Copy text={phoneUrl} /> : <p className="text-sm text-red-600">This PC has no network address yet.</p>}
          {urls.length > 1 && (
            <details className="text-xs text-slate-500"><summary className="cursor-pointer">Other addresses of this PC</summary>
              <div className="mt-1 space-y-1">{urls.filter(u => u !== phoneUrl).map(u => <Copy key={u} text={u} />)}</div>
            </details>
          )}
          <p className="text-sm mt-2">
            Last message: {c.sms?.last_at ? <b>{new Date(c.sms.last_at).toLocaleString()}{c.sms.last_from ? ` from ${c.sms.last_from}` : ''}</b> : <span className="text-slate-500">none yet</span>}
          </p>
          <button type="button" className="text-xs text-slate-500 hover:underline" onClick={async () => {
            if (!confirm('Make a new link? The phone must then get the new link, the old one stops working.')) return
            await api.post('/otp/sms-key'); load()
          }}>Phone lost? Make a new link</button>
        </div>
      </section>
    </Card>
  )
}
