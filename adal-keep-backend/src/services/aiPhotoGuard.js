/**
 * aiPhotoGuard.js — the AI never puts a picture into Photo or Full Body Photo (owner, 2026-11-26: "there is no way we can
 * classify between people" — a wrong girl's face can end up in her profile). Only a person puts pictures there.
 *
 * Each automatic path has a name and is OFF by default; ADAL_AI_PHOTOS brings paths back:
 *   ADAL_AI_PHOTOS=1            every path back (the old behaviour)
 *   ADAL_AI_PHOTOS=move,sweep   only those paths back
 * Paths that are OFF by default:
 *   move      JEV moves a head / standing photo from Passport into Photo / Full Body Photo (placement.js)
 *   split     one picture cut into passport + Photo + Full Body Photo (composite.js, placement.js, docPipeline.js)
 *   sweep     the look-back over the last 7 days (placement.js sweepRecent, undoWrongMoves)
 *   face      her face cut from the passport as her Photo (musanedImport.js)
 *   classify  a file the AI classifies as Photo / Full Body Photo is filed into a matched profile (docPipeline.js)
 * Paths that stay ON (they copy a record of the SAME passport, no face guessing): Musaned / another agency's own photo
 * (musanedContracts, musanedCopy, musanedImport's personal photo), transitions, the pictures inside a CV PDF (`pdf`).
 * The passport itself is still read and cut out as the passport.
 */
export const OFF_BY_DEFAULT = ['move', 'split', 'sweep', 'face', 'classify']
export const BOX = /^(Photo|Full Body Photo)$/

export function allowed(path, env = process.env.ADAL_AI_PHOTOS) {
  const v = String(env ?? '').trim().toLowerCase()
  if (v === '1' || v === 'all') return true
  if (v && v.split(/[,\s]+/).includes(path)) return true
  return !OFF_BY_DEFAULT.includes(path)
}
