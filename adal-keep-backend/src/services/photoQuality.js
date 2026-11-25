/**
 * photoQuality.js — pictures keep their quality (owner, 2026-11-25: "megabytes are fine, never lose quality";
 * this replaces the old 300 KB CV rule). Used by cvRender.js through three small hooks.
 *
 *   level()      the one picture level of a CV: 2x the old sizes (600 / 1000 / 1300 / 1600 px → 1200 / 2000 / 2600 /
 *                3200 px, i.e. 300 dpi of the largest frame a picture is printed in), JPEG quality 95, 4:4:4.
 *                Never a smaller level because of file size. Nothing is enlarged (withoutEnlargement stays).
 *   fitsAsIs()   a stored JPEG that already fits the frame (and needs no turning) goes in as it is: not decoded,
 *                not re-encoded, not one bit lost.
 * ADAL_PHOTO_QUALITY=0 brings the old levels back.
 */
import sharp from 'sharp'

export const on = () => process.env.ADAL_PHOTO_QUALITY !== '0'
export const FULL = { scale: 2, q: 95, palette: false }
export const level = (LEVELS, n) => (on() ? FULL : LEVELS[Math.min(Math.max(n, 0), LEVELS.length - 1)])

export async function fitsAsIs(absPath, maxPx) {
  try {
    const m = await sharp(absPath).metadata()
    return m.format === 'jpeg' && (m.orientation || 1) === 1 && Math.max(m.width, m.height) <= maxPx && (m.space || 'srgb') === 'srgb' && !m.hasAlpha
  } catch { return false }
}
/** The JPEG settings for a picture of this quality: 4:4:4 from quality 90 up. */
export const jpegOptions = (quality) => ({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' })
