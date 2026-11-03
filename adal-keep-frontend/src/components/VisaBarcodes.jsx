/**
 * On a profile: the visa's two numbers as barcodes, side by side and the same
 * size — the application number Enjaz gives once the visa is paid (even before
 * it is approved) and the visa number (Musaned's). The embassy print uses the
 * same barcodes.
 */
import { barcodeSvg } from '../lib/barcode'

function Tile({ title, value, hint }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-slate-700 dark:bg-slate-900">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      {value
        ? <>
            <div className="mt-1 w-full overflow-hidden rounded bg-white p-1 [&>svg]:h-14 [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: barcodeSvg(value, { width: 300, height: 56 }) }} />
            <p className="mt-1 font-mono text-sm font-bold tracking-wider text-slate-800 dark:text-slate-100">{value}</p>
          </>
        : <p className="mt-3 text-xs text-slate-400">{hint}</p>}
    </div>
  )
}

export default function VisaBarcodes({ profile }) {
  if (!profile.visa_application_number && !profile.visa_number) return null
  return (
    <section className="panel p-4">
      <h2 className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">🛂 Visa</h2>
      <div className="grid grid-cols-2 gap-3">
        <Tile title="Application number" value={profile.visa_application_number} hint="Given by Enjaz once the visa is paid" />
        <Tile title="Visa number" value={profile.visa_number} hint="From the Musaned contract" />
      </div>
    </section>
  )
}
