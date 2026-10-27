/**
 * Settings → Main PC & branches.
 * Which PC holds the agency's data, the addresses other PCs and phones use,
 * bringing another branch's data in, and how to set up the private link.
 */
import { IN_PHONE_APP, PAIR_PAGE } from '../lib/phoneApp'
import { useEffect, useState } from 'react'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const Copy = ({ text }) => (
  <button type="button" onClick={() => navigator.clipboard?.writeText(text)}
    className="ml-2 text-xs text-teal-600 hover:underline">copy</button>
)

const Addr = ({ label, url, note }) => (
  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
    <span className="text-slate-500 w-40 shrink-0">{label}</span>
    <code className="font-mono text-slate-800 dark:text-slate-100 break-all">{url}</code>
    <Copy text={url} />
    {note && <span className="text-xs text-slate-400 w-full sm:w-auto">{note}</span>}
  </div>
)

const STEPS = [
  ['One Tailscale account for the agency',
    'The Adal Keep installers (USB) install Tailscale. On the main PC click the Tailscale icon near the clock → Log in, with ONE agency Google account. Use that same account on every PC and phone of the agency (not personal accounts).'],
  ['Install Tailscale on every other PC and phone',
    'Branch PCs, the manager\'s laptop at home, phones (App Store / Play Store: "Tailscale"). Sign in with the same agency account. Every device now sees the main PC, from anywhere, as if it were in the office. Nothing is opened to the internet.'],
  ['Turn on the private names and https (once)',
    'On login.tailscale.com → DNS: make sure MagicDNS is on, then under HTTPS Certificates press Enable. Then press "Turn on https for phones" below on the main PC. Phones need https to install the Adal Keep app and to record voice messages.'],
  ['Branch PCs follow the main PC',
    'On each PC in the other branch that has Adal Keep installed: Settings → Main PC → "Another PC is the main PC" → type the main PC\'s Tailscale address shown below → Save. From then on that PC opens the main PC\'s Adal Keep and sends its scans there. Employee PCs (Companion only): when they cannot find the main PC, a page “Looking for the main Adal Keep PC” opens — type that address there.'],
  ['Branch had its own data? Bring it in once',
    'On the main PC, under "Bring in another branch", type the branch PC\'s address, press Check, then Merge. Nothing on the main PC is overwritten; the same document is never copied twice. Afterwards make the branch PC follow the main PC (step 4).'],
  ['From home',
    'Turn on Tailscale on the laptop or phone and open the main PC\'s Tailscale address (or the https one on phones). The data never leaves the office PC — home devices only look at it.'],
]

const ago = (t) => {
  if (!t) return 'not yet'
  const m = Math.round((Date.now() - new Date(t)) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString()
}

/** The online copy phones use when this PC is off, and the phones allowed to see it. */
function PhonesOnline({ here }) {
  const [c, setC] = useState(null)
  const [pw, setPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const savePw = async (e) => {
    e.preventDefault()
    if (pw.trim().length < 6) return setPwMsg('Use at least 6 characters.')
    try { await api.post('/mobile/phone-password', { password: pw.trim() }); setPw(''); setPwMsg('✓ Saved. Phones can pair now with the PC number and this password.'); load() }
    catch (err) { setPwMsg(err.response?.data?.error || err.message) }
  }
  const load = () => api.get('/mobile/cloud').then(r => setC(r.data)).catch(() => {})
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])
  if (!c) return null
  const sync = async () => { await api.post('/mobile/cloud/sync').catch(() => {}); setTimeout(load, 3000) }
  const remove = async (d) => {
    if (!d.revoked && !window.confirm(`Remove "${d.name || 'this phone'}"? It can no longer see the agency's data.`)) return
    await api.post(`/mobile/devices/${d.user_id}/revoke`, { revoked: !d.revoked }).catch(e => window.alert(e.response?.data?.error || e.message))
    load()
  }
  return (
    <div translate="no" className="rounded-xl p-3 mb-4 border border-slate-200 dark:border-slate-700 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xl">☁️</span>
        <p className="font-semibold flex-1 min-w-[160px]">Online copy for phones</p>
        {c.on && <Button size="sm" variant="secondary" onClick={sync} disabled={c.running}>{c.running ? 'Copying…' : 'Copy now'}</Button>}
      </div>
      {!c.on
        ? <p className="text-xs text-slate-500">Off — sign this PC in to the chat (Chat page) first; the online copy uses the same agency account.</p>
        : c.error
          ? <p className="text-xs text-red-600 dark:text-red-400">{c.error}</p>
          : <p className="text-xs text-slate-500">
              Profiles, runs, tasks and all documents are copied online every minute, so paired phones work at home and at night even when this PC is off.
              Changes made on a phone are done here when this PC is on again. Last copy: <b>{ago(c.last)}</b>
              {c.filesLeft > 0 && <> · {c.filesLeft} documents still to upload</>}
              {c.applied > 0 && <> · {c.applied} phone changes done</>}
            </p>}
      {c.on && <p className="text-[11px] text-slate-500 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 px-2 py-1.5">
        🛡️ Adal support can see this online copy — your profiles, documents, runs and tasks — to help you and supervise the work, and can act in Adal Keep for you (marked “Adal support” in the Trash and logs).
      </p>}
      {c.on && here && (
        <form onSubmit={savePw} className="rounded-lg border border-indigo-200 dark:border-indigo-800 p-2 space-y-1.5">
          <p className="text-xs font-semibold">📱 Pair phones from anywhere</p>
          <p className="text-[11px] text-slate-500">
            In the Adal Keep app: PC number <b className="font-mono">{c.pcNumber}</b> + this password. No office Wi-Fi needed.
            {c.pairing ? <> A password is set ({new Date(c.pairing.updated_at).toLocaleDateString()}) — a new one replaces it.</> : <> No password yet: phones cannot pair.</>}
          </p>
          <div className="flex gap-1.5">
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={c.pairing ? 'New phone password' : 'Phone password (6+ characters)'}
              autoComplete="new-password" className="flex-1 min-w-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-sm" />
            <Button size="sm" type="submit">Save</Button>
          </div>
          {pwMsg && <p className="text-[11px] text-slate-600 dark:text-slate-300">{pwMsg}</p>}
        </form>
      )}
      {c.devices?.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {c.devices.map(d => (
            <li key={d.user_id} className="flex items-center gap-2 py-1.5">
              <span>📱</span>
              <span className={`flex-1 truncate ${d.revoked ? 'line-through text-slate-400' : ''}`}>{d.name || 'Phone'}</span>
              <span className="text-xs text-slate-400">paired {new Date(d.created_at).toLocaleDateString()}</span>
              {here && <button type="button" onClick={() => remove(d)} className={`text-xs font-semibold ${d.revoked ? 'text-teal-600' : 'text-red-600'} hover:underline`}>{d.revoked ? 'Allow again' : 'Remove'}</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function MainPCCard() {
  const [info, setInfo] = useState(null)
  const [mode, setMode] = useState('main')
  const [mainUrl, setMainUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null) // { ok, text }
  const [source, setSource] = useState('')
  const [pre, setPre] = useState(null)
  const [job, setJob] = useState(null)
  const [guide, setGuide] = useState(false)

  const load = () => api.get('/main-pc').then(r => {
    setInfo(r.data)
    setMode(r.data.role === 'follower' ? 'follow' : 'main')
    setMainUrl(r.data.main_url || '')
  }).catch(() => setInfo({ error: true }))
  useEffect(() => { load() }, [])

  // Merge progress
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(() => api.get('/branch/merge').then(r => setJob(r.data)).catch(() => {}), 1500)
    return () => clearInterval(t)
  }, [job?.running])

  const err = (e) => e?.response?.data?.error || e.message

  const save = async () => {
    setBusy('save'); setMsg(null)
    try {
      await api.post('/main-pc', { main_url: mode === 'follow' ? mainUrl : '' })
      setMsg({ ok: true, text: mode === 'follow'
        ? 'Saved. Adal Keep restarts now; from the next start this PC opens the main PC.'
        : 'Saved. This PC is the main PC again. Adal Keep restarts now.' })
      setTimeout(load, 4000)
    } catch (e) { setMsg({ ok: false, text: err(e) }) }
    setBusy('')
  }
  const https = async () => {
    setBusy('https'); setMsg(null)
    try { await api.post('/main-pc/https'); await load(); setMsg({ ok: true, text: 'https is on. Phones can now open the https address and install the app.' }) }
    catch (e) { setMsg({ ok: false, text: err(e) }) }
    setBusy('')
  }
  const check = async () => {
    setBusy('check'); setPre(null); setMsg(null)
    try { setPre((await api.post('/branch/preview', { source })).data) } catch (e) { setMsg({ ok: false, text: err(e) }) }
    setBusy('')
  }
  const merge = async () => {
    setBusy('merge'); setMsg(null)
    try { setJob((await api.post('/branch/merge', { source })).data) } catch (e) { setMsg({ ok: false, text: err(e) }) }
    setBusy('')
  }

  if (!info) return null
  const ts = info.tailscale || {}
  const here = info.on_this_pc
  const follower = info.role === 'follower'

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no">
        <span>🖥️</span> Main PC &amp; branches
      </h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        One PC holds all the agency's data. Every branch, laptop and phone opens that PC — in the office or, through the private link, from home.
      </p>

      <div translate="no" className={`rounded-xl p-3 mb-4 text-sm ${follower ? 'bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200' : 'bg-teal-50 text-teal-900 dark:bg-teal-900/20 dark:text-teal-200'}`}>
        {follower
          ? <>This PC follows the main PC at <b className="font-mono">{info.main_url}</b>. Data, automations and the Trash are there.</>
          : <>✅ This PC is the <b>main PC</b>. The data, the files and the Trash are here.</>}
      </div>

      {!follower && info.pc_number && (
        <div translate="no" className="rounded-xl p-3 mb-4 border-2 border-dashed border-indigo-300 dark:border-indigo-700 flex flex-wrap items-center gap-3">
          <span className="text-2xl">📱</span>
          <div className="flex-1 min-w-[180px]">
            <p className="text-sm font-semibold">Phone app — this PC's number</p>
            <p className="text-xs text-slate-500">On the office Wi-Fi, open the Adal Keep app on the phone and type this number once. Away from the office (PC off too) it works from the online copy below.</p>
          </div>
          <span className="font-mono text-3xl font-bold tracking-[0.3em] text-indigo-700 dark:text-indigo-300">{info.pc_number}</span>
          {IN_PHONE_APP && <a href={PAIR_PAGE} className="w-full text-center rounded-lg border border-indigo-300 py-1.5 text-xs font-semibold text-indigo-700">⇄ Pair this phone with another PC</a>}
        </div>
      )}

      {!follower && <PhonesOnline here={here} />}

      {!follower && (
        <div className="space-y-1.5 mb-5" translate="no">
          <h3 className="font-semibold text-sm mb-1">Addresses of this main PC</h3>
          {info.lan.map(u => <Addr key={u} label="In the office" url={u} />)}
          {ts.ip
            ? <>
                <Addr label="Private link (Tailscale)" url={`http://${ts.ip}:${info.port}`} note="from the other branch and from home" />
                {ts.name && <Addr label="Private name" url={`http://${ts.name}:${info.port}`} />}
                {ts.https && <Addr label="For phones (https)" url={ts.https} note="works after “Turn on https”" />}
                {here && <div className="pt-1"><Button size="sm" variant="secondary" onClick={https} disabled={busy === 'https'}>{busy === 'https' ? 'Turning on…' : 'Turn on https for phones'}</Button></div>}
              </>
            : <p className="text-sm text-amber-700 dark:text-amber-300">
                No private link yet — Tailscale is {ts.installed ? 'installed but not connected' : 'not installed'} on this PC. See “How to set up the private link” below.
              </p>}
        </div>
      )}

      {here ? (
        <div className="mb-5" translate="no">
          <h3 className="font-semibold text-sm mb-2">Which PC is the main PC?</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {[['main', 'This PC is the main PC', 'Keeps the data. Others open it.'], ['follow', 'Another PC is the main PC', 'This PC opens that one and sends its scans there.']].map(([id, t, d]) => (
              <button key={id} type="button" onClick={() => setMode(id)}
                className={`rounded-xl border-2 p-3 text-left transition ${mode === id ? 'border-teal-500 bg-teal-50/60 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 hover:border-teal-300'}`}>
                <span className="block font-semibold text-sm">{t}</span>
                <span className="block text-xs text-slate-500">{d}</span>
              </button>
            ))}
          </div>
          {mode === 'follow' && (
            <input value={mainUrl} onChange={e => setMainUrl(e.target.value)} placeholder="Main PC address, e.g. 100.101.102.103 or http://nuzla-main:4000"
              className="mt-3 w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono" />
          )}
          {((mode === 'main') === follower || (mode === 'follow' && mainUrl.replace(/\/+$/, '') !== info.main_url)) && (
            <div className="mt-3"><Button onClick={save} disabled={busy === 'save' || (mode === 'follow' && !mainUrl.trim())}>
              {busy === 'save' ? 'Checking that PC…' : 'Save'}
            </Button></div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500 mb-5" translate="no">The main PC can be chosen only on the PC itself.</p>
      )}

      {here && !follower && (
        <div className="mb-5 border-t border-slate-200 dark:border-slate-700 pt-4" translate="no">
          <h3 className="font-semibold text-sm mb-1">Bring in another branch</h3>
          <p className="text-xs text-slate-500 mb-2">A branch that had its own Adal Keep: its profiles, documents and brokers are added here. Nothing here is overwritten; matching profiles (same passport) only get what is still empty here.</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input value={source} onChange={e => { setSource(e.target.value); setPre(null) }} placeholder="Branch PC address, e.g. 100.88.1.2"
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono" />
            <Button variant="secondary" onClick={check} disabled={!source.trim() || busy === 'check' || job?.running}>{busy === 'check' ? 'Reading…' : 'Check'}</Button>
          </div>
          {pre && !job && (
            <div className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800 p-3 text-sm">
              <p>That branch has <b>{pre.profiles}</b> profiles and <b>{pre.documents}</b> documents.</p>
              <p><b>{pre.added}</b> new profiles will be added · <b>{pre.matched}</b> are already here (only empty details are filled) · <b>{pre.new_brokers}</b> new brokers.</p>
              <div className="mt-2"><Button onClick={merge} disabled={busy === 'merge'}>Merge into this main PC</Button></div>
            </div>
          )}
          {job && (
            <div className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800 p-3 text-sm">
              {job.running
                ? <p>Merging… {job.done} / {job.total} profiles</p>
                : job.error ? <p className="text-red-600">Stopped: {job.error}</p>
                : <p className="text-teal-700 dark:text-teal-300">✅ Done.</p>}
              <div className="mt-1 h-2 rounded bg-slate-200 dark:bg-slate-700 overflow-hidden">
                <div className="h-full bg-teal-500 transition-all" style={{ width: `${job.total ? Math.round(job.done / job.total * 100) : 0}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {job.added} profiles added · {job.filled} filled · {job.docs_added} documents added · {job.docs_same} already here · {job.brokers_added} brokers added
              </p>
              {job.errors?.length > 0 && (
                <details className="mt-1 text-xs text-amber-700"><summary>{job.errors.length} could not be copied</summary>
                  <ul className="list-disc ml-5">{job.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
              )}
              {!job.running && !job.error && <p className="mt-2 text-xs">Next: on the branch PC, choose “Another PC is the main PC” and type this PC's address.</p>}
            </div>
          )}
        </div>
      )}

      {msg && <p translate="no" className={`mb-3 text-sm ${msg.ok ? 'text-teal-700 dark:text-teal-300' : 'text-red-600'}`}>{msg.text}</p>}

      <div className="border-t border-slate-200 dark:border-slate-700 pt-3" translate="no">
        <button type="button" onClick={() => setGuide(g => !g)} className="text-sm font-semibold text-teal-700 dark:text-teal-300 hover:underline">
          {guide ? '▾' : '▸'} How to set up the private link (Tailscale) — step by step
        </button>
        {guide && (
          <ol className="mt-3 space-y-3">
            {STEPS.map(([t, d], i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-teal-600 text-white text-xs flex items-center justify-center">{i + 1}</span>
                <div><p className="font-semibold text-sm">{t}</p><p className="text-sm text-slate-600 dark:text-slate-300">{d}</p></div>
              </li>
            ))}
            <li className="text-xs text-slate-500">Tailscale's free plan is enough when the agency uses one account. If a PC can't connect: check Tailscale shows “Connected” on both PCs, then press Check again.</li>
          </ol>
        )}
      </div>
    </Card>
  )
}
