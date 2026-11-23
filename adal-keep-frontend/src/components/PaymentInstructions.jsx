import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * How to pay Adal (flag "billing"): the telebirr / bank details Adal edits in
 * Adal Keep Admin → Billing. Nothing is charged here and no card is asked for:
 * the agency pays outside the app, then Adal marks the payment received and the
 * licence is extended on every PC. Shown on the Billing page and the lock screen.
 */
export function useBilling() {
  const [b, setB] = useState(null)
  useEffect(() => {
    let gone = false
    api.get('/subscription/billing', { adalNoCache: true }).then(r => { if (!gone) setB(r.data) }).catch(() => { if (!gone) setB({ enabled: false }) })
    return () => { gone = true }
  }, [])
  return b
}

const copy = (t) => { try { navigator.clipboard?.writeText(t) } catch {} }

export default function PaymentInstructions({ billing, dark = false }) {
  if (!billing?.enabled) return null
  const ins = billing.instructions || {}
  const muted = dark ? 'text-slate-400' : 'text-slate-500'
  const row = 'flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 ' + (dark ? 'bg-white/5' : 'bg-slate-50 dark:bg-slate-900/50')
  return (
    <div translate="no" className={`space-y-2 text-sm ${dark ? 'text-slate-200' : 'text-slate-700 dark:text-slate-200'}`}>
      <p className="font-semibold">Premium — everything in Adal Keep</p>
      <ul className={muted}>
        <li><b className="text-inherit">{Number(billing.prices?.six || 49999).toLocaleString('en')} ETB</b> for 6 months · <b className="text-inherit">{Number(billing.prices?.twelve || 89999).toLocaleString('en')} ETB</b> for 12 months</li>
        <li>Up to {billing.included_pcs || 3} PCs included; each extra PC {Number(billing.prices?.extra || 0).toLocaleString('en')} ETB per 6 months</li>
        {billing.prices?.indexed && <li>Priced in US dollars: today's rate is {billing.prices.rate} ETB per 1 USD{billing.prices.rate_at ? ` (set ${billing.prices.rate_at})` : ''}. You pay the ETB amount above.</li>}
      </ul>
      {!billing.has_instructions && <p className={muted}>Adal has not put the payment details here yet: call {ins.phone || 'Adal Keep'}.</p>}
      {ins.telebirr?.number && (
        <div className={row}>
          <span><b>telebirr</b> {ins.telebirr.name && <span className={muted}>· {ins.telebirr.name}</span>}<br />{ins.telebirr.number}</span>
          <button type="button" onClick={() => copy(ins.telebirr.number)} className="text-xs underline">Copy</button>
        </div>
      )}
      {(ins.banks || []).map((x, i) => (
        <div key={i} className={row}>
          <span><b>{x.bank}</b> {x.account_name && <span className={muted}>· {x.account_name}</span>}<br />{x.account_number}</span>
          <button type="button" onClick={() => copy(x.account_number)} className="text-xs underline">Copy</button>
        </div>
      ))}
      {ins.note && <p className={muted}>{ins.note}</p>}
      <p className={muted}>
        After you pay, tell Adal{ins.phone ? ` (${ins.phone})` : ''} the {billing.pc_number ? <>PC number <b>{billing.pc_number}</b> and the </> : ''}telebirr / bank reference.
        Adal marks it received and your licence is extended on every PC. The app never charges you and never asks for card details.
      </p>
    </div>
  )
}
