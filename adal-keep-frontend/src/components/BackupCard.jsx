/**
 * Settings → Backup to Telegram (main PC only).
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
const err = (e) => e?.response?.data?.error || e.message

export default function BackupCard() {
  const [c, setC] = useState(null)
  const [token, setToken] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [chats, setChats] = useState(null)
  const [busy, setBusy] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)

  const load = () => api.get('/backup').then(r => setC(r.data)).catch(() => setC(false))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!c?.progress?.running) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [c?.progress?.running])

  if (c === false || c === null) return null // not the main PC itself

  const save = async (body, ok = 'Saved') => {
    try { setC({ ...c, ...(await api.post('/backup/settings', body)).data }); toast.success(ok); return true } catch (e) { toast.error(err(e)); return false }
  }
  const step = async (name, fn) => { setBusy(name); try { await fn() } catch (e) { toast.error(err(e), { duration: 8000 }) } setBusy('') }
  const p = c.progress || {}
  const ready = c.has_token && c.has_password && c.chat_id

  const pwStep = (
        <div>
          <p className="font-semibold">{c.shared ? '' : '3. '}Choose the backup password {c.has_password && <span className="text-teal-600">✓</span>}</p>
          <p className="text-slate-500 mb-1">
            {c.shared ? <>Adal keeps a copy of the key, so Adal can always restore your data for you.</> : <><b className="text-red-600">Write it on paper and keep it outside the office.</b> Without it nobody — not even Adal — can open the backup.</>}
          </p>
          <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-2">
            <input className={field} type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder={c.has_password ? 'Saved — type a new one to change it' : 'At least 8 characters'} autoComplete="new-password" />
            <input className={field} type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Type it again" autoComplete="new-password" />
            <Button size="sm" disabled={pw.length < 8 || pw !== pw2} onClick={async () => { if (await save({ password: pw }, 'Backup password saved')) { setPw(''); setPw2('') } }}>Save</Button>
          </div>
          {c.has_password && <p className="text-xs text-amber-700 mt-1">Changing it starts a fresh full backup (older pieces stay locked with the old password).</p>}
        </div>
  )

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>💾</span> Backup to Telegram</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        A locked copy of the database and every document goes to your private Telegram channel whenever the robots are free —
        new documents within minutes, the database every 2 hours — so a stolen or broken PC loses nothing. Telegram only sees pieces it cannot open.
      </p>

      {c.shared && (
        <p className="mb-4 rounded-lg bg-teal-50 dark:bg-teal-900/20 text-teal-800 dark:text-teal-300 px-3 py-2 text-sm" translate="no">
          {c.shared_ready ? '✓' : '⏳'} Backed up every day to Adal's private storage — nothing to set up. The backup is locked; only this agency and Adal can open it, so if anything is ever lost, <b>Adal can bring it back for you</b>.
        </p>
      )}
      <ol className="space-y-4 text-sm" translate="no">
        {!c.shared && <>
        <li>
          <p className="font-semibold">1. Make a bot {c.has_token && <span className="text-teal-600">✓</span>}</p>
          <p className="text-slate-500 mb-1">In Telegram open <b>@BotFather</b> → send <code>/newbot</code> → give it a name → copy the token it gives you and paste it here.</p>
          <div className="flex gap-2">
            <input className={field} type="password" value={token} onChange={e => setToken(e.target.value)} placeholder={c.has_token ? 'Saved — paste a new one to change it' : '123456789:AA…'} autoComplete="off" />
            <Button size="sm" disabled={!token.trim()} onClick={async () => { if (await save({ bot_token: token })) setToken('') }}>Save</Button>
          </div>
        </li>
        <li>
          <p className="font-semibold">2. Make a private channel {c.chat_id && <span className="text-teal-600">✓</span>}</p>
          <p className="text-slate-500 mb-1">New Channel → Private → name it e.g. “Adal Keep Backup”. Channel info → Administrators → add your bot. Then post any message in the channel and press:</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={!c.has_token || busy === 'find'} onClick={() => step('find', async () => {
              const r = (await api.post('/backup/find-chats')).data
              setChats(r)
              if (!r.length) toast('No channel seen yet: add the bot as admin, post a message, then press again.', { icon: 'ℹ️', duration: 8000 })
            })}>{busy === 'find' ? 'Looking…' : 'Find my channel'}</Button>
            {c.chat_id && <span className="text-xs text-slate-500">Channel id {c.chat_id}</span>}
          </div>
          {chats?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {chats.map(ch => (
                <button key={ch.id} type="button" onClick={async () => { await save({ chat_id: String(ch.id) }, `Backups go to “${ch.title}”`); setChats(null) }}
                  className="rounded-lg border border-teal-400 px-3 py-1.5 text-sm hover:bg-teal-50 dark:hover:bg-teal-900/20">Use “{ch.title}”</button>
              ))}
            </div>
          )}
        </li>
        </>}
        <li>
          {c.shared
            ? <details><summary className="cursor-pointer font-semibold">Use your own backup password (not needed)</summary><div className="mt-2">{pwStep}</div></details>
            : pwStep}
        </li>
        <li>
          <p className="font-semibold">{c.shared ? 1 : 4}. When</p>
          <p className="text-slate-600 dark:text-slate-300">Any time no robot is working or waiting: a run that starts pauses the backup, and it carries on when the run is done. It never takes the internet from a run.</p>
          <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={c.enabled} onChange={e => save({ enabled: e.target.checked }, e.target.checked ? 'Backup on' : 'Backup off')} /> Backup on</label>
        </li>
      </ol>

      <div className="mt-4 rounded-xl bg-slate-50 dark:bg-slate-800 p-3 text-sm" translate="no">
        {p.running
          ? <p>⏳ Backing up — {p.step}{p.files_todo ? ` · ${p.files_done}/${p.files_todo} new documents` : ''} · {Math.round((p.bytes_sent || 0) / 1048576)} MB sent</p>
          : <p>
              Documents in the backup: <b>{c.files_sent}</b> of {c.files_total}.
              {c.last_ok ? ` Last backup: ${new Date(c.last_ok).toLocaleString()}.` : ' No backup yet.'}
              {c.last_error && <span className="text-red-600"> Last try failed: {c.last_error}</span>}
            </p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!ready || busy === 'test'} onClick={() => step('test', async () => {
            const r = (await api.post('/backup/test')).data; toast.success(`Connected to “${r.title}” — a test message was sent.`)
          })}>Send a test message</Button>
          <Button size="sm" disabled={!ready || p.running} onClick={() => step('run', async () => {
            await api.post('/backup/run'); toast('Backing up now — the first time sends every document and can take a while.', { icon: '⏳', duration: 7000 }); load()
          })}>Back up now</Button>
        </div>
      </div>

      <div className="mt-3 border-t border-slate-200 dark:border-slate-700 pt-3" translate="no">
        <button type="button" onClick={() => setRestoreOpen(o => !o)} className="text-sm font-semibold text-teal-700 dark:text-teal-300 hover:underline">
          {restoreOpen ? '▾' : '▸'} Restore from the backup (new or repaired PC)
        </button>
        {restoreOpen && <Restore shared={c.shared} />}
      </div>
    </Card>
  )
}

function Restore({ shared }) {
  const [file, setFile] = useState(null)
  const [token, setToken] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="text-slate-500">
        {shared
          ? <>Type the backup password: the newest backup of this agency is found by itself.</>
          : <>In the Telegram channel, download the <b>newest</b> “adal-backup-index.enc”. Choose it here with the bot token and the backup password.</>}
        {' '}The database on this PC is kept as a copy; documents already here are not touched. Adal Keep restarts at the end.
      </p>
      {shared
        ? <details className="text-xs text-slate-500"><summary className="cursor-pointer">An older backup file instead</summary><input type="file" accept=".enc" className="mt-1" onChange={e => setFile(e.target.files?.[0] || null)} /></details>
        : <>
            <input type="file" accept=".enc" onChange={e => setFile(e.target.files?.[0] || null)} />
            <input className={field} type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Bot token (empty = the one saved on this PC)" autoComplete="off" />
          </>}
      <input className={field} type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Backup password" autoComplete="off" />
      <Button size="sm" disabled={(!file && !shared) || !pw || busy} onClick={async () => {
        setBusy(true)
        try {
          const fd = new FormData(); if (file) fd.append('index', file); fd.append('bot_token', token); fd.append('password', pw)
          const r = (await api.post('/backup/restore', fd, { timeout: 0 })).data
          setDone(r)
        } catch (e) { toast.error(err(e), { duration: 9000 }) }
        setBusy(false)
      }}>{busy ? 'Restoring… (this takes a while)' : 'Restore'}</Button>
      {done && <p className="text-teal-700 dark:text-teal-300">✅ Restored {done.files} documents{done.database ? ' and the database (made ' + new Date(done.made).toLocaleString() + ')' : ''}. Adal Keep restarts now — open it again in a minute.</p>}
    </div>
  )
}
