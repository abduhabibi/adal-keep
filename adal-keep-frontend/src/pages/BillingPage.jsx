import PageHeader from '../components/shared/PageHeader'
import PaymentInstructions, { useBilling } from '../components/PaymentInstructions'

/** Billing: when the licence ends, how to pay, and the payments Adal marked received (flag "billing"). */
const STATE = { trial: 'Free trial', active: 'Paid', locked: 'Ended', suspended: 'Suspended' }
const day = (iso) => iso ? new Date(iso).toLocaleDateString([], { dateStyle: 'medium' }) : '—'

export default function BillingPage() {
  const b = useBilling()
  return (
    <div className="space-y-5 animate-fade-up">
      <PageHeader title="Billing" />
      {b === null ? <p className="text-sm text-slate-400">Loading…</p>
        : !b.enabled ? <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800">Billing is not turned on for this agency yet.</p>
        : (
          <>
            <section className="panel rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
              <p className="text-xs uppercase text-slate-500">Your licence</p>
              <p className="mt-1 text-lg font-bold">{b.suspended ? STATE.suspended : STATE[b.mode] || '—'}{b.for_good ? ' · for good' : ''}</p>
              {b.ends_at
                ? <p className="mt-1 text-sm">{b.mode === 'trial' ? 'The trial ends' : 'Renewal date'}: <b>{day(b.ends_at)}</b>{b.days_left != null && <> — {b.days_left} day{b.days_left === 1 ? '' : 's'} left</>}</p>
                : !b.for_good && <p className="mt-1 text-sm text-slate-500">Pay below to open Adal Keep again.</p>}
              <p className="mt-1 text-xs text-slate-500">You are reminded in the app 7 days, 3 days, 1 day and 12 hours before it ends.</p>
            </section>
            <section className="panel rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
              <PaymentInstructions billing={b} />
            </section>
            <section className="panel rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
              <p className="mb-2 text-xs uppercase text-slate-500">Payments Adal received</p>
              {b.payments.length === 0 ? <p className="text-sm text-slate-400">None yet.</p> : (
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-slate-500"><tr><th className="py-1 text-left">Date</th><th className="py-1 text-left">Method</th><th className="py-1 text-left">Reference</th><th className="py-1 text-right">ETB</th></tr></thead>
                  <tbody>{b.payments.map((p, i) => (
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-700"><td className="py-1">{p.date}</td><td>{p.method}</td><td>{p.reference || '—'}</td><td className="text-right">{Number(p.amount).toLocaleString('en')}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          </>
        )}
    </div>
  )
}
