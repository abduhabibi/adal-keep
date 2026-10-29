/**
 * What the phone's browser fills on each portal (adal-phone assets/adal-fill.js)
 * — the same boxes, found the same way and with the same values as the PC's
 * robots, so a date never lands in the wrong box:
 *
 *   step = { n: name, k: kind, at: where, v: value, m?: choice pattern }
 *     k   text | select | date | radio
 *     at  { ph }        the box whose placeholder is exactly this
 *         { phHas: [] } the box whose placeholder has one of these
 *         { label }     the box under the label whose own text matches (regex)
 *         { first }     the list whose first choice reads this
 *         { nth, sel }  the nth visible box of this kind
 *   plan = { site, scope?: { modal } | { css }, steps }
 *
 * Never a password, code, captcha or button.
 */
import { insuranceValues } from './insuranceCertificate.js'
import { visaValues } from './mofaVisa.js'

function isoDate(input) {
  if (!input) return ''
  const s = String(input).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return m[0]
  const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' }
  m = s.toUpperCase().match(/^(\d{1,2})\s+([A-Z]{3})[A-Z]*\s+(\d{2,4})$/)
  if (m && MONTHS[m[2]]) {
    let y = m[3]
    if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`
    return `${y}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`
  }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const d = new Date(s)
  return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const musanedDate = (v) => { const i = isoDate(v); return i ? new Date(`${i}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '' }
const cleanPhone = (v) => (v ? String(v).replace(/^(\+?251|0)/, '').replace(/\D/g, '') : '')
const only = (steps) => steps.filter(s => s.v != null && String(s.v).trim() !== '').map(s => ({ ...s, v: String(s.v).trim() }))

/** The settings the robots read (visa_*, insurance_*, agency_email). */
export async function fillSettings(db) {
  const rows = await db('settings').where('key', 'like', 'visa_%').orWhere('key', 'like', 'insurance_%').orWhere('key', 'agency_email').catch(() => [])
  return Object.fromEntries(rows.map(r => [r.key, String(r.value ?? '').trim()]))
}

export function fillPlans(profile, settings = {}, employeeName = '') {
  const p = profile || {}
  const plans = []

  // LMIS — the passport window (lmisWorkflow: date 0 = issue date, 1 = birth date)
  // and the police slip window.
  plans.push({
    site: 'lmis.gov.et', scope: { modal: 'Upload Passport Document' },
    steps: only([
      { n: 'Passport Number', k: 'text', at: { phHas: ['EP', 'passport'], label: 'passport (no\\.?|number)' }, v: p.passport_number },
      { n: 'Passport Issue Date', k: 'date', at: { nth: 0, sel: 'input[type="date"], input[placeholder*="mm/dd"]' }, v: isoDate(p.passport_issue_date) },
      { n: 'Passport Issued Place', k: 'text', at: { label: '(passport )?issued place|place of issue' }, v: 'Ethiopia' },
      { n: 'Place Of Birth', k: 'text', at: { label: 'place of birth' }, v: p.place_of_birth },
      { n: 'Date Of Birth', k: 'date', at: { nth: 1, sel: 'input[type="date"], input[placeholder*="mm/dd"]' }, v: isoDate(p.date_of_birth) },
    ]),
  })
  plans.push({
    site: 'lmis.gov.et', scope: { modal: 'Upload Police Certificate Payment Slip' },
    steps: only([
      { n: 'Reason', k: 'text', at: { phHas: ['labor is going', 'reason'], label: 'reason' }, v: 'WORK' },
      { n: 'Transaction Number', k: 'text', at: { phHas: ['transaction', 'order'], label: 'transaction( number)?' }, v: p.order_id || p.labor_id },
    ]),
  })

  // FetaP insurance (insuranceCertificate.fillCertificate): boxes by placeholder,
  // lists by their first choice, the first date box is the birth date.
  const iv = insuranceValues(p, settings)
  plans.push({
    site: 'niscofetap.com', scope: { css: '.modal-parent' },
    steps: only([
      { n: 'Insurance Branch', k: 'select', at: { first: 'Insurance Branch' }, m: iv.branch, v: iv.branchName },
      { n: 'Number Of Insured', k: 'text', at: { ph: 'Number Of Insured' }, v: iv.insured },
      { n: 'Title', k: 'select', at: { first: 'Title' }, m: iv.title, v: iv.title && 'x' },
      { n: 'First Name', k: 'text', at: { ph: 'First Name' }, v: iv.first },
      { n: 'Father Name', k: 'text', at: { ph: 'Father Name' }, v: iv.father },
      { n: 'Grand Father Name', k: 'text', at: { ph: 'Grand Father Name' }, v: iv.grandfather },
      { n: 'Gender', k: 'select', at: { first: 'Gender' }, m: iv.gender, v: iv.gender && 'x' },
      { n: 'Date Of Birth', k: 'date', at: { nth: 0, sel: 'input[type="date"]' }, v: iv.dob },
      { n: 'Passport Number', k: 'text', at: { ph: 'Passport Number' }, v: iv.passport },
      { n: 'Labor ID', k: 'text', at: { ph: 'Labor ID' }, v: iv.labor_id },
      { n: 'Phone', k: 'text', at: { ph: 'Phone' }, v: iv.phone },
      { n: 'Email', k: 'text', at: { ph: 'Email' }, v: iv.email },
      { n: 'Woreda', k: 'text', at: { ph: 'Woreda' }, v: iv.woreda },
      { n: 'Sub City', k: 'text', at: { ph: 'Sub city' }, v: iv.sub_city },
      { n: 'Region', k: 'select', at: { first: 'Region' }, m: iv.region, v: 'x' },
      { n: 'Country Of Destination', k: 'select', at: { first: 'Country Of Destination' }, m: iv.destination, v: 'x' },
    ]),
  })

  // MOFA visa (mofaVisa.fillForm): every box under its label.
  const vv = visaValues(p, {}, settings)
  const sel = (n, label, m) => ({ n, k: 'select', at: { label }, m, v: m && 'x' })
  const txt = (n, label, v) => ({ n, k: 'text', at: { label }, v })
  const date = (n, label, v) => ({ n, k: 'date', at: { label }, v })
  plans.push({
    site: 'mofa.gov.sa',
    steps: only([
      sel('Visa Type', 'visa type', vv.visa_type),
      sel('Current Nationality', 'current nationality', vv.nationality),
      sel('Nearest Saudi Mission', 'nearest saudi mission', vv.mission),
      sel('Number of Entries', 'number of entries', vv.entries),
      sel('Visa Validity', 'visa validity', vv.validity),
      sel('Duration Of Stay', 'duration of stay', vv.duration),
      txt('Visa Number', 'visa (?:no\\.?|number)', vv.visa_number),
      txt('Last/Family Name', '(?:last|family|last ?/ ?family) name', vv.family),
      txt('First Name', 'first name', vv.first),
      txt('Second/Father Name', '(?:second ?/ ?father|father|second) name', vv.father),
      txt('Other/G.Father Name', '(?:other ?/ ?g\\.? ?father|grand ?father|other) name', vv.grandfather),
      { n: 'Previous nationality', k: 'radio', at: { label: 'do you have previous nationality' }, m: vv.previous_nationality, v: 'x' },
      txt('Passport Number', 'passport (?:no\\.?|number)', vv.passport),
      sel('Passport Type', 'passport type', vv.passport_type),
      sel('Issuing Country', 'issuing country', vv.issuing_country),
      date('Date of Issue', 'date of issue', vv.issue_date),
      date('Date of Expiry', 'date of expiry', vv.expiry_date),
      txt('Place of Birth', 'place of birth', vv.birth_place),
      date('Date of Birth', 'date of birth', vv.dob),
      txt('ID Number', 'id number', vv.id_number),
      sel('Religion', 'religion', vv.religion),
      sel('Marital Status', 'marital status', vv.marital),
      sel('Gender', 'gender', vv.gender),
      sel('Occupation', 'occupation', vv.occupation),
      txt('Qualification', 'qualification', vv.qualification),
      txt('Source of Degree', 'source of degree', vv.degree_source),
      txt('KSA Home Address', 'ksa home address', vv.ksa_address),
      txt('Email Address', 'e-?mail(?: address)?', vv.email),
      txt('Sponsor Name', 'sponsor name', vv.sponsor_name),
      txt('Sponsor ID Number', 'sponsor id (?:no\\.?|number)', vv.sponsor_id),
      txt('Sponsor Address', 'sponsor address', vv.sponsor_address),
      txt('Phone Number', 'phone (?:no\\.?|number)', vv.sponsor_phone),
      sel('Transport Mode', 'transport mode', vv.transport),
      sel('Port of Entry', 'port of entry', vv.port),
      date('Expected Entry Date To KSA', 'expected entry date to ksa', vv.entry_date),
      txt('Purpose', 'purpose', vv.purpose),
    ]),
  })

  // Musaned — the candidate form (musanedWorkflow): text boxes under their
  // labels; dates as "March 5, 2024". Its typed lists, skills and photo stay
  // for the person.
  const married = String(p.marital_status || '').toUpperCase() === 'MARRIED'
  const rel = String(p.religion || '')
  const children = p.children_count != null && String(p.children_count).trim() !== '' ? p.children_count : '0'
  plans.push({
    site: 'musaned.com.sa',
    steps: only([
      { n: 'ID Number', k: 'text', at: { phHas: ['id number'] }, v: p.passport_number },
      { n: 'Marital Status', k: 'radio', at: { label: 'marital status' }, m: p.marital_status ? (married ? '^\\s*married' : '^\\s*single') : '', v: p.marital_status && 'x' },
      { n: 'Religion', k: 'radio', at: { label: 'religion' }, m: rel ? (/muslim|islam/i.test(rel) && !/non/i.test(rel) ? '^\\s*muslim' : 'non\\s*muslim') : '', v: rel && 'x' },
      txt('Mobile Number', 'mobile number', cleanPhone(p.phone_number)),
      txt('E-Mail', 'e-?mail', settings.agency_email),
      txt('Number Of Children', 'number of children', children),
      txt('Passport Issue Place', 'passport issue place', 'Addis Ababa'),
      date('Passport Issue Date', 'passport issue date', musanedDate(p.passport_issue_date)),
      date('Passport Expiry Date', 'passport expiry date', musanedDate(p.passport_expiry_date)),
      txt('City', 'city', 'Addis Ababa'),
      txt('Address', 'address', 'Kolfe Keraniyo'),
      txt('Relative name', 'relative name', employeeName),
      txt('Relative kinship', 'relative kinship', 'cousin'),
      txt('Relative phone', 'relative phone', cleanPhone(p.emergency_phone || p.phone_number)),
      txt('Relative address', 'relative address', 'Addis Ababa'),
    ]),
  })

  return plans.filter(pl => pl.steps.length)
}
