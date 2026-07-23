export const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending', className: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200' },
  { value: 'in_progress', label: 'In progress', className: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' },
  { value: 'completed', label: 'Completed', className: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' },
]

export function statusMeta(status) {
  return STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0]
}

export function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
