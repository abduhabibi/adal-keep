/**
 * keepOriginals.js — a picture that is replaced is not destroyed (owner, 2026-11-25: "always keep the original file").
 * The single-file upload and "assign tray file" replace what a field held: its database row goes (the field shows the new
 * file) but the old picture moves to data/SafeStorage/replaced/ instead of being deleted. Never throws. Off: ADAL_PHOTO_QUALITY=0.
 */
import fs from 'fs'
import path from 'path'

export function keepReplaced(abs, { root = path.join(process.cwd(), 'data', 'SafeStorage') } = {}) {
  try {
    if (process.env.ADAL_PHOTO_QUALITY === '0') { if (fs.existsSync(abs)) fs.unlinkSync(abs); return null }
    if (!abs || !fs.existsSync(abs)) return null
    const dir = path.join(root, 'replaced')
    fs.mkdirSync(dir, { recursive: true })
    const to = path.join(dir, `${Date.now()}_${path.basename(abs)}`)
    try { fs.renameSync(abs, to) } catch { fs.copyFileSync(abs, to); fs.unlinkSync(abs) }
    return to
  } catch { return null }
}
