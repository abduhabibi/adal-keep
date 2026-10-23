/**
 * Settings → Sign-in codes (main PC only): the Musaned authenticator key and
 * the phone that forwards LMIS SMS codes. See backend services/otp.js.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
const err = (e) => e?.response?.data?.error || e.message

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
          <li>In Musaned, open the page that adds an authenticator app (it shows a QR code). Sign in → account / security → “Authenticator”, or the QR page Musaned shows when it first asks.</li>
          <li>Scan the QR code with the phone app as usual (Google or Microsoft Authenticator) — the phone keeps working too.</li>
          <li>Under the QR code press <b>“Unable to scan?”</b> (or “Enter key manually”). Copy the key it shows (letters and digits, like <code>JBSW Y3DP EHPK 3PXP…</code>) and paste it here.</li>
          <li>Finish Musaned's page with the code from the phone. Then compare: the number below must be the same as the phone's.</li>
        </ol>
        <div className="flex gap-2">
          <input className={field} type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off"
            placeholder={c.musaned_totp ? 'Saved — paste a new key to change it' : 'Authenticator key or otpauth:// link'} />
          <Button size="sm" disabled={!key.trim()} onClick={async () => {
            try { await api.post('/otp/totp', { secret: key }); setKey(''); toast.success('Saved — compare the number with the phone'); load() } catch (e) { toast.error(err(e), { duration: 8000 }) }
          }}>Save</Button>
        </div>
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
