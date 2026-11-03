/**
 * Settings → Integrations → Telegram: this agency's own backup channel.
 * Adal's storage channel is shared by every agency; as more agencies join it
 * fills up (and Telegram may close a channel that gets too much). Each agency
 * can have a private channel of its own: make it, add Adal's bot as its admin,
 * post one message, pick it here — the next backup sends everything there.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message

export default function TelegramChannelCard() {
  const [c, setC] = useState(null)
  const [bot, setBot] = useState(null)
  const [chats, setChats] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => api.get('/backup').then(r => setC(r.data)).catch(() => setC(false))
  useEffect(() => { load(); api.get('/backup/bot').then(r => setBot(r.data.username)).catch(() => {}) }, [])
  if (!c) return null // not the main PC

  const find = async () => {
    setBusy('find')
    try {
      const r = (await api.post('/backup/find-chats')).data
      setChats(r)
      if (!r.length) toast('No channel seen yet: add the bot as admin, post a message in the channel, then press again.', { icon: 'ℹ️', duration: 8000 })
    } catch (e) { toast.error(err(e)) }
    setBusy('')
  }
  const use = async (ch) => {
    if (!confirm(`Send this agency's backups to “${ch.title}” from now on? Everything is sent there again (the first time takes a while).`)) return
    try {
      await api.post('/backup/settings', { chat_id: String(ch.id) })
      await api.post('/backup/test').catch(() => {})
      toast.success(`Backups go to “${ch.title}”`)
      setChats(null); load()
    } catch (e) { toast.error(err(e)) }
  }

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>✈️</span> Telegram — this agency's backup channel</h2>
      <p className="text-sm text-slate-500 mb-3" translate="no">
        {c.own_channel
          ? <>✓ Backups go to <b>this agency's own channel</b> (id {c.chat_id}){c.files_total ? ` — ${c.files_sent} of ${c.files_total} documents sent there so far` : ''}.</>
          : <>Backups now go to Adal's <b>shared</b> storage channel. Give this agency a channel of its own, so one agency's backups never crowd out another's.</>}
      </p>
      <ol className="space-y-2 text-sm list-decimal pl-5" translate="no">
        <li>In Telegram: <b>New Channel → Private</b>, name it e.g. “{'<agency>'} Adal Backup”.</li>
        <li>Channel info → Administrators → <b>Add admin</b> → {bot ? <><code className="rounded bg-slate-100 px-1 dark:bg-slate-800">@{bot}</code> (Adal's backup bot)</> : 'your backup bot'}.</li>
        <li>Post any message in the channel, then press <b>Find the channel</b> and choose it.</li>
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy === 'find' || !c.has_token} onClick={find}>{busy === 'find' ? 'Looking…' : '🔎 Find the channel'}</Button>
        {chats?.map(ch => (
          <button key={ch.id} type="button" onClick={() => use(ch)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${String(ch.id) === String(c.chat_id) ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20' : 'border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20'}`}>
            {String(ch.id) === String(c.chat_id) ? '✓ ' : 'Use '}“{ch.title}”
          </button>
        ))}
      </div>
    </Card>
  )
}
