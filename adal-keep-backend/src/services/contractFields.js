/**
 * Her details that Musaned's contract page shows (saved as profiles.contract_data:
 * "Date of Birth", "Passport Issue Date", "Religion" …) into her profile's own
 * fields, where the CV and the robots read them — only fields still empty;
 * what was typed in Adal Keep stays (asked on 2026-11-13: the CV left out the
 * passport dates and place of birth of girls added from the Musaned list).
 */
const date = (v) => {
  const s = String(v || '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null
}
const text = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() && !/^(-|n\/a|null|undefined)$/i.test(String(v).trim()) ? String(v).trim() : null

// profile column ← the contract's labels, first found wins
const MAP = [
  ['date_of_birth', ['Date of Birth'], date],
  ['passport_issue_date', ['Passport Issue Date'], date],
  ['passport_expiry_date', ['Passport Expiry Date'], date],
  ['gender', ['Gender'], text],
  ['marital_status', ['Marital Status'], text],
  ['religion', ['Religion'], text],
  ['education_level', ['Education level', 'Education Level'], text],
  ['children_count', ['Number Of Children', 'Number of Children'], (v) => (/^\d{1,2}$/.test(String(v).trim()) ? Number(v) : null)],
  // Her city in Ethiopia (Musaned: City / Address) is where the other profiles keep her place of birth.
  ['place_of_birth', ['City', 'Address'], text],
  ['living_town', ['City', 'Address'], text],
  ['phone_number', ['Candidate · Mobile Number'], text],
  ['first_name', ['Given Names'], text],
  ['last_name', ['Surname'], text],
  ['emergency_name', ['Relative name'], text],
  ['emergency_phone', ['Relative phone'], text],
  ['emergency_relationship', ['Relative kinship'], text],
]

/** The empty profile fields her contract data can fill: { column: value }. */
export function fieldsFromContract(profile, cols = null) {
  let c = profile?.contract_data
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  if (!c || typeof c !== 'object') return {}
  const out = {}
  for (const [col, labels, read] of MAP) {
    if (cols && !cols[col]) continue
    const had = profile[col]
    if (had != null && String(had).trim() !== '') continue
    for (const l of labels) {
      const v = read(c[l])
      if (v != null && v !== '') { out[col] = v; break }
    }
  }
  return out
}

/** Writes them (one profile, or every profile with contract data); returns how many profiles gained something. */
export async function fillFromContracts(db, profileId = null) {
  if (!(await db.schema.hasColumn('profiles', 'contract_data'))) return 0
  const cols = await db('profiles').columnInfo()
  let q = db('profiles').whereNotNull('contract_data').where('contract_data', '!=', '')
  if (profileId) q = q.where('id', profileId)
  let n = 0
  for (const p of await q.select('*')) {
    const upd = fieldsFromContract(p, cols)
    if (!Object.keys(upd).length) continue
    await db('profiles').where('id', p.id).update({ ...upd, updated_at: new Date().toISOString() })
    n++
  }
  return n
}
