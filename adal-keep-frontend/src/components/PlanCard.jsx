/**
 * Settings → Plan: this agency's plan, how long it is paid (or the trial),
 * each feature (on / not in the plan / offered by Adal Keep), and "I want it".
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import Card from './shared/Card'
import Button from './shared/Button'
import { usePlan, loadPlan, wantFeature, planName } from '../lib/plan'

const err = (e) => e?.response?.data?.error || e.message
const day = (t) => t ? new Date(t).toLocaleDateString() : null

export default function PlanCard() {
  const plan = usePlan()
  const [busy, setBusy] = useState('')
  if (!plan) return null
  const p = plan.plans.find(x => x.key === plan.plan)
  const refresh = async () => {
    setBusy('refresh')
    try { await loadPlan({ fresh: true }); toast.success('Plan up to date') } catch (e) { toast.error(err(e)) }
    setBusy('')
  }
  const want = async (f) => {
    setBusy(f.key)
    try { await wantFeature(f.key); toast.success(`Adal Keep was told you want ${f.title}`, { duration: 6000 }) } catch (e) { toast.error(err(e)) }
    setBusy('')
  }
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold flex items-center gap-2"><span>⭐</span> {p?.name || plan.plan} plan</h2>
          <p className="text-sm text-slate-500">
            {plan.from_adal ? <>
              {plan.paid_until && <>Paid until <b>{day(plan.paid_until)}</b>. </>}
              {plan.trial_until && !plan.paid_until && <>Free trial until <b>{day(plan.trial_until)}</b>. </>}
            </> : 'The free trial: every feature, to try them all.'}
            {p?.price ? ` ${p.price.toLocaleString()} ETB / 6 months.` : ''}
          </p>
          {plan.note && <p className="mt-1 text-sm text-teal-700 dark:text-teal-300">{plan.note}</p>}
        </div>
        <Button size="sm" variant="secondary" disabled={busy === 'refresh'} onClick={refresh}>{busy === 'refresh' ? 'Checking…' : '↻ Refresh'}</Button>
      </div>

      {plan.offers?.length > 0 && (
        <div className="mb-3 space-y-2">
          {plan.offers.map(o => {
            const f = plan.features.find(x => x.key === o.feature)
            return (
              <div key={o.id} className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-900/20">
                <span className="text-xl">🆕</span>
                <span className="min-w-0 flex-1 text-sm"><b>{o.feature_title}</b>{f?.about ? ` — ${f.about}` : ''}</span>
                <Button size="sm" disabled={busy === o.feature} onClick={() => want(f || { key: o.feature, title: o.feature_title })}>I want it</Button>
              </div>
            )
          })}
        </div>
      )}

      <ul className="grid gap-2 sm:grid-cols-2">
        {plan.features.map(f => (
          <li key={f.key} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${f.state === 'on' ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-900/10' : 'border-slate-200 dark:border-slate-700'}`}>
            <span className="mt-0.5">{f.state === 'on' ? '✅' : f.state === 'offered' ? '🆕' : '🔒'}</span>
            <span className="min-w-0 flex-1">
              <b>{f.title}</b>
              <span className="block text-xs text-slate-500">{f.about}</span>
              {f.state !== 'on' && <span className="block text-xs text-slate-500">In the {planName(plan, f.plan)} plan</span>}
            </span>
            {f.state !== 'on' && <button type="button" disabled={busy === f.key} onClick={() => want(f)} className="shrink-0 text-xs font-semibold text-teal-700 hover:underline dark:text-teal-300">I want it</button>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">Profiles, documents, CVs, checklists, brokers, tasks, chat, the phone app and backups are in every plan.</p>
    </Card>
  )
}
