import fs from 'fs'
const p = 'src/services/docPipeline.js'
let s = fs.readFileSync(p, 'utf8')

if (s.includes('SLIP_ATTACH_MARKER')) { console.log('already patched'); process.exit(0) }

// 1. Insert slip-specific profile matching before the existing non-passport block
const anchor = "    // Attach to existing profile only. Try passport_number, national_id, then name."
if (!s.includes(anchor)) { console.error('anchor not found'); process.exit(1) }

const slipBlock = `    // SLIP_ATTACH_MARKER — slips match by reference_name first
    if (result.doc_type === 'Slip' && ex.reference_name) {
      const refName = sanitizeName(ex.reference_name)
      if (refName) {
        profile = await db('profiles').where('full_name', 'like', '%' + refName + '%').first()
        if (!profile) {
          const lastWord = refName.split(/\\s+/).pop()
          if (lastWord && lastWord.length > 2) {
            profile = await db('profiles').where('full_name', 'like', '%' + lastWord + '%').first()
          }
        }
        if (profile) {
          console.log(tag, 'slip matched to profile #' + profile.id + ' (' + profile.full_name + ') via reference')
        } else {
          log('slip reference "' + refName + '" did not match any profile — attaching to closest? no, skipping')
          return { ok: false, reason: 'no_slip_match', docType: 'Slip' }
        }
      }
    }

`

s = s.replace(anchor, slipBlock + anchor)

// 2. After profile is found, write order_id and middle_name through the update chain
s = s.replace(
  /(const upd = \{ updated_at: new Date\(\)\.toISOString\(\) \})/,
  `$1`
)
// Extend the profile update fields to include new ones
s = s.replace(
  /for \(const k of \['first_name','last_name','date_of_birth','gender','nationality',/,
  `for (const k of ['first_name','middle_name','last_name','date_of_birth','gender','nationality','order_id',`
)

// Also write order_id on new profiles
s = s.replace(
  /(      first_name: ex\.first_name \|\| '',\n      last_name: ex\.last_name  \|\| '',)/,
  `$1
      middle_name: ex.middle_name || '',`
)
// Add order_id to insert if it exists
s = s.replace(
  /(      nationality: ex\.nationality \|\| 'Ethiopian',\n      status: 'active',)/,
  `$1`
)

fs.writeFileSync(p, s)
console.log('✓ pipeline slip attachment installed')
