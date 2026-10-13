import fs from 'fs'
const p = 'src/services/docPipeline.js'
let s = fs.readFileSync(p, 'utf8')

if (s.includes('DEDUPE_MARKER')) { console.log('already patched'); process.exit(0) }

// Replace the existing isGeneratedCV guard block with a broader dedupe check
const oldGuard = /(  \/\/ Guard: skip CVs we generated ourselves[\s\S]*?return \{ ok: false, reason: 'generated_cv' \}\n  \})/
const newGuard = `  // DEDUPE_MARKER — skip anything already known to the system
  if (db) {
    const fname = path.basename(filePath)
    let fsize = 0
    try { fsize = fs.statSync(filePath).size } catch {}

    // 1. Skip our own generated CVs (by prefix or DB row)
    if (/^AdalCV_/i.test(fname)) {
      console.log(tag, 'skip — generated CV (prefix):', fname)
      return { ok: false, reason: 'generated_cv' }
    }
    try {
      const gen = await db('generated_cvs').where('filename', fname).first()
      if (gen) {
        console.log(tag, 'skip — generated CV (db match):', fname)
        return { ok: false, reason: 'generated_cv' }
      }
    } catch {}

    // 2. Skip files that match a stored file by original_name + size (catches re-downloads)
    try {
      const existing = await db('files')
        .where('original_name', fname)
        .andWhere('size', fsize)
        .first()
      if (existing) {
        console.log(tag, 'skip — already ingested (name+size match):', fname)
        return { ok: false, reason: 'already_ingested' }
      }
    } catch {}

    // 3. Skip files whose name matches a CV template source_file (user re-drops a template)
    try {
      const tpl = await db('cv_templates').where('source_file', fname).first()
      if (tpl) {
        console.log(tag, 'skip — CV template source:', fname)
        return { ok: false, reason: 'cv_template_source' }
      }
    } catch {}
  }`

if (oldGuard.test(s)) {
  s = s.replace(oldGuard, newGuard)
} else {
  // Fallback — insert before the stage block
  const anchor = "  // Stage the file into SafeStorage"
  if (!s.includes(anchor)) { console.error('anchor not found'); process.exit(1) }
  s = s.replace(anchor, newGuard + '\n\n' + anchor)
}

fs.writeFileSync(p, s)
console.log('✓ dedupe guard installed in docPipeline')
