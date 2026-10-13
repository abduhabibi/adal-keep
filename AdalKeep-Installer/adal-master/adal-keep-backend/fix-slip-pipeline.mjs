import fs from 'fs'
const p = 'src/services/docPipeline.js'
let s = fs.readFileSync(p, 'utf8')

if (s.includes('SLIP_ATTACH_MARKER')) { console.log('already patched'); process.exit(0) }

// ---- 1. Insert slip-matching helper right before getOrCreateProfile (line ~99) ----
const helperAnchor = 'async function getOrCreateProfile(ex, fullName, db) {'
if (!s.includes(helperAnchor)) { console.error('helper anchor not found'); process.exit(1) }

const slipHelper = `// SLIP_ATTACH_MARKER — find the worker profile a slip belongs to
// Priority: reference_name (the worker) → last word of reference → full_name of customer
async function findSlipProfile(ex, db) {
  const candidates = []
  if (ex.reference_name) candidates.push(sanitizeName(ex.reference_name))
  if (ex.customer_name)  candidates.push(sanitizeName(ex.customer_name))
  candidates.push(sanitizeName(ex.full_name))

  for (const cand of candidates) {
    if (!cand || cand.length < 3) continue
    let hit = await db('profiles').where('full_name', 'like', '%' + cand + '%').first()
    if (hit) return hit
    const lastWord = cand.split(/\\s+/).pop()
    if (lastWord && lastWord.length > 3) {
      hit = await db('profiles').where('full_name', 'like', '%' + lastWord + '%').first()
      if (hit) return hit
    }
  }
  return null
}

${helperAnchor}`

s = s.replace(helperAnchor, slipHelper)

// ---- 2. Replace the getOrCreateProfile call with slip-aware logic ----
const callAnchor = '  const profile = await getOrCreateProfile(ex, fullName, db)'
if (!s.includes(callAnchor)) { console.error('call anchor not found'); process.exit(1) }

const newCall = `  // Slips must attach to an existing worker profile, matched via reference_name
  let profile
  if (result.doc_type === 'Slip') {
    profile = await findSlipProfile(ex, db)
    if (!profile) {
      log('slip did not match any profile — skipping')
      return { ok: false, reason: 'no_slip_match', docType: 'Slip' }
    }
    console.log(tag, 'slip matched profile #' + profile.id + ' (' + profile.full_name + ')')
    if (ex.order_id) {
      await db('profiles').where('id', profile.id).update({
        order_id: ex.order_id,
        updated_at: new Date().toISOString(),
      })
      console.log(tag, 'order_id "' + ex.order_id + '" stored on profile #' + profile.id)
    }
  } else {
    profile = await getOrCreateProfile(ex, fullName, db)
  }`

s = s.replace(callAnchor, newCall)

// ---- 3. Extend the upd array to include new fields ----
s = s.replace(
  /for \(const k of \['first_name','last_name','date_of_birth','gender','nationality',/,
  `for (const k of ['first_name','middle_name','last_name','date_of_birth','gender','nationality','order_id',`
)

// ---- 4. Extend the insert object to include middle_name ----
s = s.replace(
  /(      first_name: ex\.first_name \|\| '',\n      last_name: ex\.last_name  \|\| '',)/,
  `$1
      middle_name: ex.middle_name || '',`
)

fs.writeFileSync(p, s)
console.log('✓ slip handling installed')
