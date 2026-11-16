// How far something is, as a percent and a thin bar (backup, documents being read).
const STAGES = [
  [/^starting/i, 5],
  [/^reading the document/i, 12],
  [/JEV is looking/i, 25],
  [/passport lines/i, 40],
  [/at the same time/i, 40],
  [/place of birth/i, 50],
  [/asking Gemini/i, 55],
  [/MinerU/i, 60],
  [/every detail/i, 75],
  [/^saving it/i, 90],
]
/** A document's reading stage ("JEV is looking at it") as a percent, or null when unknown. */
export function stagePercent(stage) {
  for (const [re, p] of STAGES) if (re.test(String(stage || ''))) return p
  return null
}

export function Bar({ percent, className = '' }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0))
  return (
    <span className={`block h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700 ${className}`} role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <span className="block h-full rounded-full bg-teal-500 transition-[width] duration-500" style={{ width: `${p}%` }} />
    </span>
  )
}
