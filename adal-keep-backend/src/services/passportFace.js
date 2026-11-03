/**
 * Her face cut from the passport's data page, for a CV when no separate photo
 * exists (Musaned's "personal photo" is often the passport again).
 *
 * ICAO 9303 passport data page (TD3): 125 × 88 mm, the two machine-readable
 * lines at the bottom, the photo on the left. The lowest dark text in the
 * picture is the bottom of those lines; the picture's width is the page's
 * width. From those two, the photo's place is known (a little margin added).
 * Saved as "…_photo.jpg": Adal Keep's name for "face cut from a passport", so
 * Musaned's add-candidate run still asks for a real personal photo.
 */
import sharp from 'sharp'

export async function faceFromPassport(input, output) {
  const img = sharp(input).rotate()
  const { width: W, height: H } = await img.metadata()
  if (!W || !H) return null
  const { data, info } = await img.clone().greyscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  // The lowest row with enough dark ink across the middle of the page = the MRZ's bottom.
  let mrzBottom = h - 1
  for (let y = h - 1; y > h * 0.5; y--) {
    let dark = 0
    for (let x = Math.floor(w * 0.1); x < w * 0.9; x++) if (data[y * w + x] < 110) dark++
    if (dark > w * 0.8 * 0.08) { mrzBottom = y; break }
  }
  const s = w / 125                         // pixels per millimetre
  const pageBottom = mrzBottom + 4 * s      // the MRZ ends ~4 mm above the page's edge
  const pageTop = pageBottom - 88 * s
  const box = { left: 4 * s, top: pageTop + 17 * s, right: 36 * s, bottom: pageTop + 64 * s }
  const left = Math.max(0, Math.round(box.left)), top = Math.max(0, Math.round(box.top))
  const width = Math.min(w - left, Math.round(box.right - box.left)), height = Math.min(h - top, Math.round(box.bottom - box.top))
  if (width < 30 || height < 40) return null
  await sharp(input).rotate().extract({ left, top, width, height })
    .resize({ width: Math.max(300, width), withoutEnlargement: false }).jpeg({ quality: 90 }).toFile(output)
  return output
}
