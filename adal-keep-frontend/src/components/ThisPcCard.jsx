import { useEffect, useState } from 'react'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

/**
 * Settings → This PC: is this PC equipped well enough? A plain list of what is OK, what is
 * weak and the fix (backend services/pcCheck.js; the installer shows the same list). It only
 * warns. Not there when switched off (ADAL_PC_CHECK=0).
 */
const MARK = {
  ok: ['✓', 'text-emerald-600 dark:text-emerald-400'],
  weak: ['!', 'text-amber-600 dark:text-amber-400'],
  tip: ['i', 'text-sky-600 dark:text-sky-400'],
  unknown: ['?', 'text-slate-400'],
}

export default function ThisPcCard() {
  const [r, setR] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = (fresh = false) => {
    setBusy(true)
    return api.get(`/system/pc-check${fresh ? '?fresh=1' : ''}`, { timeout: 45000 })
      .then(x => setR(x.data)).catch(() => setR(v => v || { on: true, items: [], why: 'This PC could not be measured.' })).finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [])
  if (r && r.on === false) return null
  const role = r?.role === 'companion' ? 'Companion PC' : 'Main PC'
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2">This PC's equipment</h2>
      <p className="text-xs text-slate-500 mb-4">
        {r?.role ? `What a ${role} needs. ` : ''}A weak line does not stop anything: it makes Adal Keep slower.
      </p>
      {!r && <p className="text-sm text-slate-500">Measuring this PC…</p>}
      {r?.why && <p className="text-sm text-slate-500 mb-3">{r.why}</p>}
      <ul className="space-y-2">
        {(r?.items || []).map(i => {
          const [m, c] = MARK[i.state] || MARK.unknown
          return (
            <li key={i.key} className="flex gap-3 text-sm">
              <span className={`w-5 shrink-0 text-center font-bold ${c}`}>{m}</span>
              <span className="min-w-0">
                <span className={i.state === 'weak' ? 'font-semibold' : ''}>{i.text}</span>
                {i.fix && <span className="block text-slate-500">{i.fix}</span>}
              </span>
            </li>
          )
        })}
      </ul>
      {r && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => load(true)} isLoading={busy}>Check again</Button>
          {r.at && <span className="text-xs text-slate-400">Measured {new Date(r.at).toLocaleTimeString()}</span>}
        </div>
      )}
    </Card>
  )
}
