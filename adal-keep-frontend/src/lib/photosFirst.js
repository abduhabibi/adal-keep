// Her "Photo" and "Full-body photo" come first among her documents (2026-11-19),
// and a missing one shows its empty upload slot at the front at once, even
// while a step shows only what it needs (PC, Companion and phone alike).
export const PHOTO_SLOTS = ['Photo', 'Full Body Photo']

export const hasFiles = (f) => !!(f && (f.files || []).length)

/** The fields with Photo, then Full Body Photo, first; the rest keep their order. */
export function photosFirst(fields = []) {
  const rank = (f) => { const i = PHOTO_SLOTS.indexOf(f?.name); return i < 0 ? PHOTO_SLOTS.length : i }
  return (fields || []).map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0])
}

/** The photo slots she has as fields but with no file in them yet. */
export function missingPhotos(fields = []) {
  return PHOTO_SLOTS.filter(n => { const f = (fields || []).find(x => x.name === n); return f && !hasFiles(f) })
}
