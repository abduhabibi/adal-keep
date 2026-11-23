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
  if (!data) return data
  const town = data.living_town !== undefined ? data.living_town : current?.living_town
  const birth = data.place_of_birth !== undefined ? data.place_of_birth : current?.place_of_birth
  if (blank(town) && !blank(birth)) data.living_town = String(birth).trim()
  return data
}
