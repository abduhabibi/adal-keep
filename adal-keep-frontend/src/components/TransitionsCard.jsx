/**
 * Settings → Transitions: an agency brings everything from the system it used
 * before. The site opens in its own window, a person signs in there, and the
 * copy goes on out of sight. Nothing on that site is changed.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'
import Input from './shared/Input'

const SYSTEMS = [
  ['easyenjaz', 'EasyEnjaz', 'easyenjaz.com'],
  ['enjazplus', 'EnjazPlus', 'v2.enjazplus.com'],
  ['musaned', 'Musaned', 'tawtheeq.musaned.com.sa'],
  ['pextran', 'Pextran', 'your agency\'s own address'],
]
const err = (e) => e?.response?.data?.error || e.message
const busy = (s) => s?.status === 'signing-in' || s?.status === 'copying'

function Result({ s }) {
  if (s.status === 'failed') return <p className="text-sm text-red-600">{s.error}</p>
  if (s.status === 'stopped') return <p className="text-sm text-slate-500">Stopped. What was saved stays; pressing again goes over the rest.</p>
  if (s.status === 'idle') return null
  return (
    <div className="space-y-1 text-sm">
      {s.step && <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="h-2 w-2 shrink-0 animate-ping rounded-full bg-teal-500" />{s.step}</p>}
      {s.status === 'done' && <p className="font-semibold text-teal-700 dark:text-teal-400">✓ Finished</p>}
      {s.status !== 'signing-in' && (
        <p className="text-slate-500">
          {s.people} found · {s.created} new profiles · {s.updated} filled in · {s.files} files · {s.templates} CV templates
          {s.skipped > 0 && ` · ${s.skipped} templates could not be made`}
        </p>
      )}
      {s.status === 'done' && !s.people && <p className="text-amber-700 dark:text-amber-400">Nobody with a passport number was found on this site. Everything it showed is kept in {s.folder}.</p>}
    </div>
  )
}

export default function TransitionsCard() {
  const [all, setAll] = useState({})
  const [link, setLink] = useState('')
  const load = () => api.get('/transitions').then(r => setAll(r.data)).catch(() => {})
  useEffect(() => { load() }, [])
  const running = Object.values(all).some(busy)
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
  }, [running])

  const start = async (id) => {
    try { await api.post(`/transitions/${id}/start`, id === 'pextran' ? { link } : {}); load() }
    catch (e) { toast.error(err(e)) }
  }
  const stop = (id) => api.post(`/transitions/${id}/stop`).then(load).catch(e => toast.error(err(e)))

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🚚</span> Move here from another system</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        Press a system, sign in in the window that opens, and Adal Keep copies your people, their files and CV templates. Profiles already here keep what you typed and only get their empty fields filled. Nothing on the other system is changed.
      </p>
      <div className="space-y-3" translate="no">
        {SYSTEMS.map(([id, name, where]) => {
          const s = all[id]
          return (
            <div key={id} className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{name}</p>
                  <p className="text-xs text-slate-500">{where}</p>
                </div>
                {busy(s)
                  ? <Button size="sm" variant="secondary" onClick={() => stop(id)}>Stop</Button>
                  : <Button size="sm" disabled={running || (id === 'pextran' && !link.trim())} onClick={() => start(id)}>Move from {name}</Button>}
              </div>
              {id === 'pextran' && !busy(s) && (
                <Input value={link} onChange={e => setLink(e.target.value)} placeholder="https://zadulmead.agency.pextran.com/" inputMode="url" autoComplete="off" />
              )}
              {s && <Result s={s} />}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
