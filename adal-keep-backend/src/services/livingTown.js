// Her living town is her place of birth unless someone typed another one
// (asked on 2026-11-23: "set living town same as birth place").
const blank = (v) => v == null || String(v).trim() === ''

/** The living town to show: the one written, else her place of birth. */
export const livingTownOf = (p = {}) => (!blank(p.living_town) ? String(p.living_town).trim() : String(p.place_of_birth || '').trim())

/**
 * Before a profile is saved: an empty living town takes her place of birth.
 * `data` is what is being written, `current` her saved row (for an update).
 * Changes `data` in place and returns it.
 */
export function withLivingTown(data, current = {}) {
  // Shown filled (fillTown) but not written: a corrected place of birth takes it along.
  if (data.place_of_birth && current && blank(current.living_town) && !blank(current.place_of_birth)
    && String(data.living_town ?? '').trim() === String(current.place_of_birth).trim()) data.living_town = String(data.place_of_birth).trim()
  if (!data) return data
  const town = data.living_town !== undefined ? data.living_town : current?.living_town
  const birth = data.place_of_birth !== undefined ? data.place_of_birth : current?.place_of_birth
  if (blank(town) && !blank(birth)) data.living_town = String(birth).trim()
  return data
}

/** A profile read: an empty living town shows her place of birth (nothing is written). Off: ADAL_TOWN_FILL=0. */
export function fillTown(p) {
  try {
    if (process.env.ADAL_TOWN_FILL !== '0' && p && 'living_town' in p && blank(p.living_town) && !blank(p.place_of_birth)) p.living_town = livingTownOf(p)
  } catch {}
  return p
}
