/**
 * liveTiles.js — only the parts of a picture that changed, for a viewer on a slow line.
 *
 * Measured (2026-11-25, i5): finding and cutting the changed parts costs 40 ms of processor a picture (the JPEG must
 * be unpacked), sending the whole one 0.1 ms. So it is done for a slow line only (liveStream.js); on the office
 * network the whole picture (about 60 KB, only when the page changed) is the cheaper one for a 2-core PC.
 * Off: ADAL_LIVE_TILES=0.
 */
const T = 64                           // (a multiple of 16: JPEG's own blocks, so what did not change unpacks the same)
export const tilesOn = () => process.env.ADAL_LIVE_TILES !== '0'

let sharp = null
async function raw(jpg) {
  if (!sharp) { sharp = (await import('sharp')).default }
  const { data, info } = await sharp(jpg, { sequentialRead: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height, ch: info.channels }
}

/** The smallest boxes (rows of tiles, joined) that differ between two unpacked pictures of one size. */
export function changedBoxes(a, b) {
  const { w, h, ch } = b
  const rows = []
  for (let y = 0; y < h; y += T) {
    let x0 = -1, x1 = -1
    for (let x = 0; x < w; x += T) {
      const len = Math.min(T, w - x) * ch
      let diff = false
      for (let r = y; r < Math.min(h, y + T) && !diff; r++) {
        const o = (r * w + x) * ch
        diff = a.data.compare(b.data, o, o + len, o, o + len) !== 0
      }
      if (diff) { if (x0 < 0) x0 = x; x1 = Math.min(w, x + T) }
    }
    if (x0 < 0) continue
    const last = rows[rows.length - 1]
    const bottom = Math.min(h, y + T)
    if (last && last.y + last.h === y) { const left = Math.min(last.x, x0), right = Math.max(last.x + last.w, x1); last.x = left; last.w = right - left; last.h = bottom - last.y }
    else rows.push({ x: x0, y, w: x1 - x0, h: bottom - y })
  }
  return rows
}

/**
 * One tile-maker for one picture stream: next(jpg) → null (send the whole picture) or
 * [{ x, y, w, h, jpg }] (an empty list: nothing to see changed).
 */
export function tileMaker(quality = 50) {
  let prev = null
  return {
    reset() { prev = null },
    async next(jpg) {
      const b = await raw(jpg)
      const a = prev
      prev = b
      if (!a || a.w !== b.w || a.h !== b.h) return null
      const boxes = changedBoxes(a, b)
      const area = boxes.reduce((n, x) => n + x.w * x.h, 0)
      if (area > 0.5 * b.w * b.h) return null
      const out = []
      for (const x of boxes) out.push({ ...x, jpg: await sharp(b.data, { raw: { width: b.w, height: b.h, channels: b.ch } }).extract({ left: x.x, top: x.y, width: x.w, height: x.h }).jpeg({ quality }).toBuffer() })
      return out
    },
  }
}
