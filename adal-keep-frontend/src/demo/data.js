/**
 * Demo data — every person, number and document here is made up.
 * The demo build answers the app's API from this (see server.js), so the
 * public demo never touches a real server or a real customer.
 */

export const FIELD_NAMES = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report', 'Insurance', 'COC', 'Visa',
  'Saudi-letter', 'Musaned', 'Broker ID', 'Ticket-ongoing', 'Ticket-deported', 'Police Clearance',
  'Labour ID', 'Slip', 'Experience Form', 'Employee ID', 'Client ID', 'Self Video', 'Photo', 'Full Body Photo',
]

const PEOPLE = [
  ['SARA', 'ABEBE', 'KEBEDE', 'F'], ['HANA', 'TESFAYE', 'GIRMA', 'F'], ['MERON', 'ALEMU', 'BEKELE', 'F'],
  ['FATUMA', 'MOHAMMED', 'ALI', 'F'], ['TIGIST', 'HAILE', 'WOLDE', 'F'], ['SELAM', 'GIRMA', 'TADESSE', 'F'],
  ['ZENEBECH', 'ASSEFA', 'DEMISSIE', 'F'], ['AMINA', 'HUSSEIN', 'YUSUF', 'F'], ['BETHLEHEM', 'MENGISTU', 'ABERA', 'F'],
  ['RAHEL', 'TADESSE', 'GEBRE', 'F'], ['KEDIJA', 'AHMED', 'OMAR', 'F'], ['MARTA', 'BELAY', 'KASSA', 'F'],
  ['ALMAZ', 'DEREJE', 'TEKLE', 'F'], ['ZAHARA', 'ABDELLA', 'MUSA', 'F'], ['LIDYA', 'SOLOMON', 'HAILU', 'F'],
  ['MEKDES', 'YOHANNES', 'AYELE', 'F'], ['NEJAT', 'KEMAL', 'SHAFI', 'F'], ['EDEN', 'FIKRE', 'LEMMA', 'F'],
]
const TOWNS = ['ADDIS ABABA', 'JIMMA', 'DESSIE', 'ADAMA', 'HAWASSA', 'BAHIR DAR', 'HARAR', 'GONDAR', 'NORTH SHEWA']
const COUNTRIES = ['Saudi Arabia', 'Kuwait', 'United Arab Emirates', 'Qatar', 'Jordan']
const SKILLS = ['cleaning', 'ironing', 'washing', 'baby_sitting', 'cooking', 'elderly_care']

export const BROKERS = [
  { id: 1, name: 'Tesfaye Brokerage', address: 'Addis Ababa, Merkato', contact1: '0911000101' },
  { id: 2, name: 'Amanuel Agency', address: 'Jimma', contact1: '0911000102' },
  { id: 3, name: 'Hawassa Link', address: 'Hawassa', contact1: '0911000103' },
  { id: 4, name: 'Dessie Partners', address: 'Dessie', contact1: '0911000104' },
]

const day = (n) => new Date(Date.UTC(2026, 9, 18) - n * 86400000).toISOString()
const pad = (n, w) => String(n).padStart(w, '0')

export function seed() {
  const files = []      // { id, profile_id, field, original_name, mimetype, size, kind }
  const fields = []     // { id, profile_id, field_template_id, name }
  const profiles = PEOPLE.map(([given, middle, last, gender], i) => {
    const id = 101 + i
    const ready = i < 6        // first ones have every document: try the automations on them
    const skills = {}
    SKILLS.forEach((s, k) => { if ((i + k) % 3 !== 0) skills[s] = true })
    const p = {
      id,
      full_name: `${given} ${middle} ${last}`,
      first_name: given, middle_name: middle, last_name: last,
      phone_number: `09${pad(11000000 + i * 7919, 8)}`,
      national_id: `ETH-${pad(3000 + i * 37, 4)}-${pad(8000 + i * 53, 4)}`,
      passport_number: `EP${pad(1000000 + i * 104729, 7)}`,
      status: ready ? 'active' : 'pending',
      room: null, table_name: null, box_number: null,
      broker_id: BROKERS[i % BROKERS.length].id,
      notes: null, photo_path: null, editing_started_at: null,
      created_at: day(30 - i), updated_at: day(Math.max(0, 12 - i)),
      company_id: null, branch_id: null, assigned_to: null, created_by: 'demo',
      date_of_birth: `${1990 + (i % 12)}-${pad(1 + (i % 12), 2)}-${pad(3 + (i * 5) % 25, 2)}`,
      nationality: 'ETHIOPIAN', gender,
      passport_issue_date: `2025-${pad(1 + (i % 12), 2)}-10`,
      passport_expiry_date: `2030-${pad(1 + (i % 12), 2)}-09`,
      passport_file: null,
      place_of_birth: TOWNS[i % TOWNS.length],
      surname_am: null, given_names_am: null, mrz_raw: null,
      religion: i % 3 === 0 ? 'Christian' : 'Muslim',
      marital_status: i % 4 === 0 ? 'Married' : 'Single',
      children_count: i % 4 === 0 ? 1 : 0,
      weight: String(50 + (i % 15)), height: String(152 + (i % 18)),
      complexion: null, living_town: null,
      mother_name: `ASTER ${last}`, father_name: middle, spouse_name: null,
      education_level: ['Grade 8', 'Grade 10', 'Grade 12'][i % 3],
      speaks_english: i % 2, speaks_arabic: (i + 1) % 2,
      skills: JSON.stringify(skills),
      previous_employment: null, full_body_photo_path: null,
      region: ['Oromia', 'Amhara', 'Sidama', 'Addis Ababa'][i % 4], zone_subcity: null,
      labor_id: i < 12 ? `EF${pad(12000000 + i * 15485, 8)}` : null,
      personal_number: null,
      emergency_name: `ASTER ${last}`, emergency_phone: `09${pad(22000000 + i * 31, 8)}`,
      emergency_gender: 'F', emergency_relationship: 'Mother',
      cooking_skill: i % 2 ? 'Arabic food' : 'Ethiopian food',
      order_id: ready ? `FT${pad(26000000 + i * 811, 8)}` : null,
      destination_country: COUNTRIES[i % COUNTRIES.length],
      passport_ticks: ready ? 3 : 1, verified_at: ready ? day(5) : null, mrz_source: ready ? 'mrz' : null,
      work_experience: i % 3 === 1 ? 'Have experience' : 'No experience',
      experience_country: i % 3 === 1 ? COUNTRIES[(i + 1) % COUNTRIES.length] : null,
      experience_years: i % 3 === 1 ? 2 : null,
    }
    FIELD_NAMES.forEach((name, k) => {
      const fid = id * 100 + k + 1
      fields.push({ id: fid, profile_id: id, field_template_id: k + 1, name })
      const has =
        name === 'Passport' ||
        (name === 'Photo' && i < 14) ||
        (name === 'Full Body Photo' && i < 8) ||
        (name === 'Slip' && ready) ||
        (name === 'Medical Report' && i < 4)
      if (has) {
        const kind = { Passport: 'passport', Photo: 'photo', 'Full Body Photo': 'fullbody', Slip: 'slip', 'Medical Report': 'medical' }[name]
        files.push({
          id: fid, profile_id: id, field_id: fid, field: name, kind,
          original_name: `${kind}_${id}.svg`, path: `demo/${kind}_${id}.svg`, mimetype: 'image/svg+xml', size: 48000,
        })
      }
    })
    return p
  })

  return {
    version: 3,
    profiles, fields, files,
    brokers: BROKERS.map(b => ({ ...b, logo: null, contact2: null, notes: null, created_at: day(60), updated_at: day(60), company_id: null, created_by: 'demo' })),
    notifications: [
      { id: 1, company_id: 1, type: 'passport_unreadable', title: 'Passport not readable: IMG_2290.jpg', body: 'The MRZ check digits did not verify. Re-upload a clear, straight-on photo of the passport data page.', created_day: day(1).slice(0, 10), created_at: day(1), updated_at: day(1) },
      { id: 2, company_id: 1, type: 'run_done', title: 'Police clearance ready to submit: SARA ABEBE KEBEDE', body: 'Everything is filled in. Check the form and press Submit Request.', created_day: day(2).slice(0, 10), created_at: day(2), updated_at: day(2) },
    ],
    tasks: [
      { id: 1, type: 'approval', document_type: 'Passport', profile_data: JSON.stringify({ full_name: 'EDEN FIKRE LEMMA', passport_number: 'EP2782122' }), source_file: 'photo_2210.jpg', status: 'pending', created_at: day(0), updated_at: day(0), approved_at: null, declined_at: null, decline_reason: null, is_ai_created: 1, payload: '{}', description: null, priority: 'normal', due_date: null, assigned_to: 1, created_by: 'ai', company_id: 1, profile_id: 118, title: 'New passport: EDEN FIKRE LEMMA' },
    ],
    employees: [
      { id: 1, name: 'Demo Admin', username: 'admin', phone_work: '0911000000', role: 'admin', created_at: day(90), device_serial: null },
      { id: 2, name: 'Front Desk', username: 'desk', phone_work: '0911000001', role: 'employee', created_at: day(40), device_serial: null },
    ],
    lmisAccounts: [{ id: 1, name: 'Demo agency', login_value: 'agency.demo', password: '********', phone: '0911000000', agency_name: 'Demo Agency PLC', is_default: 1, last_used_at: day(1), created_at: day(90), updated_at: day(1) }],
    musanedAccounts: [{ id: 1, name: 'Demo office', username: 'office.demo', password: '********', phone: '0911000000', notes: '', is_default: 1, last_used_at: day(1), created_at: day(90), updated_at: day(1) }],
    checklists: [],
    quickLinks: [],
    cvTemplates: [{
      id: 1, name: 'Standard CV', agency_name: 'Demo Agency PLC', agency_name_ar: 'وكالة تجريبية', logo_path: null,
      salary: 1000, currency: 'SAR', country: 'Saudi Arabia', contract_years: 2,
      html_content: '', css_content: '', placeholders: '[]', source_file: 'demo', is_active: 1,
      created_at: day(90), updated_at: day(90), header_path: null, include_passport: 1, footer_path: null,
      passport_h1: 'PASSPORT', passport_h1_color: '#0f766e', passport_include_header: 0, passport_include_footer: 0,
    }],
    generated: [],
    runs: [],
    nextId: 1000,
  }
}
