/**
 * Settings → Main PC & branches.
 * Which PC holds the agency's data, the addresses other PCs and phones use,
 * bringing another branch's data in, and how to set up the private link.
 */
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
    'On the main PC, open tailscale.com → Download → Windows, install it, and sign in with ONE agency Google/Microsoft account. Use that same account on every PC and phone of the agency (not personal accounts).'],
  ['Install Tailscale on every other PC and phone',
    'Branch PCs, the manager\'s laptop at home, phones (App Store / Play Store: "Tailscale"). Sign in with the same agency account. Every device now sees the main PC, from anywhere, as if it were in the office. Nothing is opened to the internet.'],
  ['Turn on the private names and https (once)',
    'On login.tailscale.com → DNS: make sure MagicDNS is on, then under HTTPS Certificates press Enable. Then press "Turn on https for phones" below on the main PC. Phones need https to install the Adal Keep app and to record voice messages.'],
  ['Branch PCs follow the main PC',
    'On each PC in the other branch that has Adal Keep installed: Settings → Main PC → "Another PC is the main PC" → type the main PC\'s Tailscale address shown below → Save. From then on that PC opens the main PC\'s Adal Keep and sends its scans there. Employee PCs (Companion only): put ADAL_HOST_URL=<that address> in companion.conf.'],
  ['Branch had its own data? Bring it in once',
    'On the main PC, under "Bring in another branch", type the branch PC\'s address, press Check, then Merge. Nothing on the main PC is overwritten; the same document is never copied twice. Afterwards make the branch PC follow the main PC (step 4).'],
  ['From home',
    'Turn on Tailscale on the laptop or phone and open the main PC\'s Tailscale address (or the https one on phones). The data never leaves the office PC — home devices only look at it.'],
]

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
