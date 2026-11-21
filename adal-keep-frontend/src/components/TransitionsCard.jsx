/**
 * Settings → Transitions: an agency brings everything from the system it used
 * before. The site opens out of sight on the PC of the office that does it
 * fastest; a person signs in through its live view (here or in the sidebar's
 * Browsers), and the copy goes on. Nothing on that site is changed.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'
import Input from './shared/Input'

const LiveTab = lazy(() => import('./LiveTab'))

const SYSTEMS = [
  ['enjazplus', 'EnjazPlus', 'v2.enjazplus.com'],
  ['musaned', 'Musaned', 'tawtheeq.musaned.com.sa'],
  ['pextran', 'Pextran', 'your agency\'s own address'],
]
const err = (e) => e?.response?.data?.error || e.message
const busy = (s) => s?.status === 'signing-in' || s?.status === 'copying'
// Also a move waiting to go on by itself after a restart: it can be stopped too.
const active = (s) => busy(s) || s?.status === 'waiting'

function Result({ s }) {
  if (s.status === 'failed') return <p className="rounded-lg bg-red-50 px-2 py-1.5 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">Not finished: {s.error || 'it stopped'}. What was saved stays; pressing Move again goes on from there.</p>
  if (s.status === 'stopped') return <p className="text-sm text-slate-500">Stopped. What was saved stays; pressing again goes over the rest.</p>
  if (s.status === 'idle') return null
  return (
    <div className="space-y-1 text-sm">
      {s.step && <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300"><span className="h-2 w-2 shrink-0 animate-ping rounded-full bg-teal-500" />{s.step}</p>}
      {s.status === 'done' && <p className="font-semibold text-teal-700 dark:text-teal-400">✓ Finished</p>}
      {s.status !== 'signing-in' && s.status !== 'waiting' && (
        <p className="text-slate-500">
          {s.brokers ? `${s.brokers} brokers · ` : ''}{s.people} found · {s.created} new profiles · {s.updated} filled in · {s.files} files · {s.templates} CV templates
          {s.skipped > 0 && ` · ${s.skipped} templates could not be made`}
          {s.failed > 0 && ` · ${s.failed} files could not be read: press the button again to try them`}
        </p>
      )}
      {s.status === 'done' && !s.people && <p className="text-amber-700 dark:text-amber-400">Nobody with a passport number was found on this site. Everything it showed is kept in {s.folder}.</p>}
    </div>
  )
}

export default function TransitionsCard() {
  const [all, setAll] = useState({})
  // The Pextran address stays in the box once typed (this device remembers it).
  const [link, setLinkNow] = useState(() => { try { return localStorage.getItem('adal-pextran-link') || '' } catch { return '' } })
  const setLink = (v) => { setLinkNow(v); try { localStorage.setItem('adal-pextran-link', v) } catch {} }
  const [starting, setStarting] = useState(null)
  const load = () => api.get('/transitions').then(r => { setAll(r.data); if (r.data?.pextran?.link) setLinkNow(l => l || r.data.pextran.link) }).catch(() => {})
  useEffect(() => { load() }, [])
  const running = Object.values(all).some(active)
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
  }, [running])

  const [choose, setChoose] = useState(null) // the Musaned accounts to pick from
  const start = async (id, accountId) => {
    // Musaned: signed in with a saved account — asked which when there are two or more.
    if (id === 'musaned' && accountId === undefined) {
      const accounts = await api.get('/musaned/accounts').then(r => r.data || []).catch(() => [])
      if (accounts.length > 1) { setChoose(accounts); return }
      accountId = accounts[0]?.id ?? null
    }
    setChoose(null)
    setStarting(id)
    try { await api.post(`/transitions/${id}/start`, id === 'pextran' ? { link } : accountId ? { account_id: accountId } : {}); await load() }
    catch (e) { toast.error(err(e)) }
    setStarting(null)
  }
  // Never where the Move button is, and it asks: a second click on Move must not end the copy.
  const stop = (id, name) => {
    if (!confirm(`Stop copying from ${name}? What is saved stays, and pressing Move again goes on from there.`)) return
    api.post(`/transitions/${id}/stop`).then(load).catch(e => toast.error(err(e)))
  }
  const [live, setLive] = useState(null)
  const show = (id) => setLive(id)

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-3 flex items-center gap-2" translate="no">Move here from another system</h2>
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
                <Button size="sm" disabled={!!starting || running || (id === 'pextran' && !link.trim())} onClick={() => start(id)}>
                  {busy(s) || starting === id ? 'Working…' : `Move from ${name}`}
                </Button>
              </div>
              {id === 'pextran' && !busy(s) && (
                <Input value={link} onChange={e => setLink(e.target.value)} placeholder="https://zadulmead.agency.pextran.com/" inputMode="url" autoComplete="off" />
              )}
              {s && <Result s={s} />}
              {active(s) && (
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {s.status === 'signing-in' && <button type="button" onClick={() => show(id)} className="font-semibold text-teal-700 hover:underline dark:text-teal-400">Open it to sign in</button>}
                  <button type="button" onClick={() => stop(id, name)} className="text-slate-400 hover:text-red-600 hover:underline">Stop the copy</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {choose && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-3 sm:items-center" onClick={() => setChoose(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-2xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
            <p className="font-bold">Move from which Musaned account?</p>
            <div className="space-y-2">
              {choose.map(a => (
                <button key={a.id} type="button" onClick={() => start('musaned', a.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 text-left hover:border-teal-400 hover:bg-teal-50 dark:border-slate-700 dark:hover:bg-teal-900/20">
                  <span><span className="block font-semibold">{a.name}</span><span className="text-xs text-slate-500">{a.username}</span></span>
                  {a.is_default ? <span className="text-[10px] font-semibold text-teal-600">default</span> : null}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setChoose(null)} className="mt-3 w-full text-sm text-slate-500 underline">Cancel</button>
          </div>
        </div>
      )}
      {live && createPortal(<Suspense fallback={null}><LiveTab runId={`tr-${live}`} startFull onClose={() => setLive(null)} /></Suspense>, document.body)}
    </Card>
  )
}
