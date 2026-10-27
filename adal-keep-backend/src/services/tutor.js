/**
 * tutor.js — the Adal tour.
 *
 * Once a day, the first page a person opens shows up to 3 things worth
 * knowing (the page they are on first), with Next and Skip tour. Everything
 * is shown within 2 weeks: when days are missed the day's share grows.
 * A lesson counts as known once it was shown or its feature was used.
 * "Show me" opens the page and points at the real button; the tour only
 * explains and points: it never presses buttons, starts runs or changes data.
 */
import { askGemini, isGeminiConfigured } from './geminiClassifier.js'

// target = the element's data-tour value. route ':p' / ':cv' / ':police' /
// ':musaned' = an example profile picked from today's data.
export const LESSONS = [
  { id: 'search', route: '/', target: 'search-pad',
    am: ['ማንኛውንም ሰራተኛ በቅጽበት ያግኙ', 'በየትኛውም ገጽ Ctrl+K ይጫኑ እና ስም፣ የፓስፖርት ቁጥር ወይም የሌበር መታወቂያ ይጻፉ። Running / Not running ስራ ያላቸውን ይለያል።'],
    en: ['Find any worker in a second', 'Press Ctrl+K on any page and type a name, passport number or labor ID. Running / Not running splits out the workers with a run.'] },
  { id: 'new_profile', route: '/profiles', target: 'new-profile',
    am: ['ፕሮፋይልን ከፓስፖርት ይጀምሩ', 'አዲስ ፕሮፋይል ይጫኑ፣ መጀመሪያ ፓስፖርቱን ያስገቡ፡ ስም፣ ቁጥር እና ቀኖች ራሳቸው ይሞላሉ።'],
    en: ['Start a profile from the passport', 'Press New profile and add the passport first: the name, number and dates fill themselves.'] },
  { id: 'auto_docs', route: '/profiles', target: null,
    am: ['ሰነዶች ራሳቸው ይመዝገቡ', 'ፓስፖርት፣ ፎቶ እና ስሊፕ ወደ Downloads ወይም Telegram ያስቀምጡ። አዳል ኪፕ ያነባቸዋል፣ ፓስፖርቱን ያረጋግጣል፣ በትክክለኛው ፕሮፋይል ላይ ያስቀምጣቸዋል።'],
    en: ['Let documents file themselves', 'Save passports, photos and slips into Downloads or Telegram. Adal Keep reads them, checks the passport and files them on the right profile.'] },
  { id: 'upload_doc', route: '/profiles/:p', target: 'field-upload',
    am: ['ሰነድ ወደ ፕሮፋይል ያክሉ', 'እያንዳንዱ የሰነድ አይነት የራሱ ሳጥን አለው። ስካኑን በትክክለኛው ሳጥን ለማስገባት + Add files ይጫኑ።'],
    en: ['Add a document to a profile', 'Each document type has its own box. Press + Add files to put a scan in the right box.'] },
  { id: 'filters', route: '/profiles', target: null,
    am: ['ያልተሞሉትን ይፈልጉ', 'በፕሮፋይሎች ገጽ Married፣ Country፣ Skill ወይም Religion ውስጥ "Unfilled" ይምረጡ፡ ገና ያልተሞሉት ብቻ ይቀራሉ፣ አንድ በአንድ ይሞሏቸው።'],
    en: ['Find what is still unfilled', 'On the Profiles page pick "Unfilled" in Married, Country, Skill or Religion: only the profiles still missing it stay, so you can fill them one by one.'] },
  { id: 'tasks', route: '/tasks', target: null,
    am: ['ተግባራት ገጽ ለምን አስፈላጊ ነው', 'ሲስተሙ ያነበበው እያንዳንዱ ሰነድ እዚህ ይታያል፡ ምን እንዳገኘ እና በየትኛው ፕሮፋይል እንዳስቀመጠው። እርስዎን የሚጠብቁ ስራዎችም (ካፕቻ፣ Submit፣ SAVE) እዚህ ናቸው።'],
    en: ['Why the Tasks page matters', 'Every document the system reads shows up here: what it found and which profile it filed it on. Runs waiting for you (captcha, Submit, SAVE) are here too.'] },
  { id: 'notifications', route: '/notifications', target: null,
    am: ['ማሳወቂያዎች ለምን አስፈላጊ ናቸው', 'እርስዎን የሚፈልጉ ችግሮች እዚህ ይመጣሉ፡ የማይነበብ ፓስፖርት፣ ያልተሳኩ ወይም የሚጠብቁ ስራዎች። በየጠዋቱ መጀመሪያ እዚህ ይመልከቱ።'],
    en: ['Why Notifications matter', 'Problems that need you land here: unreadable passports, failed or waiting runs. Look here first every morning.'] },
  { id: 'checklist', route: '/checklist', target: 'new-checklist',
    am: ['ቼክሊስት ያዘጋጁ', 'ስም ይስጡት (ለምሳሌ የዚህ ሳምንት ተጓዦች)፣ ሰራተኞችን ያክሉ፡ እያንዳንዱ የሚቀረውን ሰነድ ያሳያል፣ ይታተማልም።'],
    en: ['Make a checklist', "Give it a name (e.g. this week's travellers) and add workers: it shows which documents each one still needs, and it prints."] },
  { id: 'cv_create', route: '/profiles/:cv', target: 'cv-create',
    am: ['ከፕሮፋይሉ ሲቪ ያዘጋጁ', 'ፕሮፋይሉ ፎቶ፣ ሙሉ ሰውነት ፎቶ፣ የሌበር መታወቂያ እና ክህሎቶች ሲኖሩት Create CV ሲቪውን ያዘጋጅልዎታል።'],
    en: ['Make a CV from the profile', 'When a profile has a photo, a full-body photo and skills, Create CV builds the CV for you.'] },
  { id: 'cv_page', route: '/cvs', target: 'new-cv',
    am: ['ሁሉም ሲቪዎች በአንድ ቦታ', '+ New CV ይጫኑ፣ ሰራተኛ እና ቴምፕሌት ይምረጡ። የተዘጋጁትን ሲቪዎች እዚህ ያውርዱ ወይም በሌላ ቴምፕሌት ይቀይሩ።'],
    en: ['All CVs in one place', 'Press + New CV, pick a worker and a template. Download the CVs made, or switch one to another template.'] },
  { id: 'musaned_run', route: '/profiles/:musaned', target: 'run-musaned_add_candidate',
    am: ['እጩውን በሙሳነድ ላይ ያስገቡ', 'Add Candidate on Musaned ይጫኑ። ካፕቻውን እርስዎ ይፈታሉ፤ ሲስተሙ ፎቶ፣ ክህሎት እና ልምድን ጨምሮ ሙሉ ፎርሙን ሞልቶ ያረጋግጣል፣ SAVE እንዲጫኑ ይጠብቃል።'],
    en: ['Add the candidate on Musaned', 'Press Add Candidate on Musaned. You solve the captcha; it fills and checks the whole form (photo, skills, experience) and waits for you to press SAVE.'] },
  { id: 'police_run', route: '/profiles/:police', target: 'run-police_certificate',
    am: ['የፖሊስ ማስረጃውን ሲስተሙ ያዘጋጅ', 'Make Police Certificate ይጫኑ። LMIS ውስጥ ገብቶ የሌበር መታወቂያውን ይፈልጋል፣ ፓስፖርት እና ፎቶ ያያይዛል፣ ሁሉንም በራሱ ታብ ይሞላል፣ Submit እንዲጫኑ ይጠብቅዎታል።'],
    en: ['Let the system make the police certificate', 'Press Make Police Certificate. It signs in to LMIS, finds the labor ID, attaches the passport and photo, fills everything in its own tab and waits for you to press Submit.'] },
  { id: 'brokers', route: '/brokers', target: null,
    am: ['የእያንዳንዱን አመቻች ሰራተኞች ይዩ', 'አመቻችን ይክፈቱ እና ያመጣቸውን ሰራተኞች ብቻ ይዩ እና ይፈልጉ።'],
    en: ["See each broker's workers", 'Open a broker to see and search only the workers they brought.'] },
  { id: 'broker_create', route: '/employees', target: 'new-broker',
    am: ['አመቻች ይፍጠሩ', '+ ደላላ አክል ይጫኑ፣ ስም፣ አድራሻ እና ስልክ ይጻፉ። ከዚያ ሰራተኞችን ለአመቻቹ ይመድቡ።'],
    en: ['Create a broker', 'Press + ደላላ አክል, type the name, address and phone. Then assign workers to that broker.'] },
  { id: 'employee_create', route: '/employees', target: 'new-employee',
    am: ['ሰራተኛ ይፍጠሩ', '+ ሰራተኛ አክል ይጫኑ፡ ሙሉ ስም፣ መለያ ስም እና የስራ ስልክ። ሰራተኛው በራሱ ኮምፒውተር በዚህ ይገባል፣ ስራውና እድገቱም የራሱ ይሆናል።'],
    en: ['Create an employee', "Press + ሰራተኛ አክል: full name, username and work phone. They sign in on their own PC with it, and their work and progress are their own."] },
  { id: 'theme', route: '/settings', target: 'theme-picker',
    am: ['መልክዎን ይምረጡ', 'ብርሃን፣ ጨለማ ወይም የሚንቀሳቀሰው ቀለማት።'],
    en: ['Pick your look', 'Light, Dark or the moving Gradient theme.'] },
  { id: 'updates', route: '/settings', target: 'check-updates',
    am: ['ሁልጊዜ የቅርብ ጊዜውን ይጠቀሙ', 'ምንም ስራ በማይሰራበት ጊዜ አዳል ኪፕ አዲሱን ስሪት በራሱ ይጭናል። Check updates አሁኑኑ ያደርገዋል።'],
    en: ['Stay up to date', 'Adal Keep installs new versions by itself when no run is working. Check updates does it right now.'] },
  { id: 'journey_filter', route: '/profiles', target: 'journey-filter',
    am: ['ማን የት እንደደረሰ በአንድ ጠቅታ', 'ከፕሮፋይሎች ርዕስ አጠገብ ያለው መስመር CV → ሙሳነድ → ዋፊድ ከዚያ LMIS እና ኤምባሲ ይከፈላል። አንዱን ደረጃ ይጫኑ፡ ያንን የጨረሱት ብቻ ይቀራሉ፤ እንደገና ሲጫኑ ይለቀቃል።'],
    en: ['See who reached which step in one click', 'The line beside the Profiles title goes CV → Musaned → Wafid, then splits to LMIS and the Embassy. Click a step: only the profiles that finished it stay; click again to let go.'] },
  { id: 'journey_profile', route: '/profiles/:p', target: 'profile-journey',
    am: ['የእሷ ጉዞ በፕሮፋይሉ ላይ', 'በእያንዳንዱ ፕሮፋይል ላይ ያለው መስመር የተጠናቀቀውን (አረንጓዴ)፣ እየሄደ ያለውን (ቢጫ) እና የቀረውን ያሳያል። ደረጃውን ሲጫኑ ወደ AI ስራዎቹ ይወስድዎታል።'],
    en: ['Her journey on the profile', 'The line on each profile shows what is done (green), running (amber) and still to do. Click a step to jump to its AI actions.'] },
  { id: 'labor_id', route: '/profiles/:p', target: 'labor-id',
    am: ['የሌበር መታወቂያውን እዚሁ ይቀይሩ', 'Edit ሳይጫኑ፣ በፕሮፋይሉ አናት ያለውን Labor ID ይጫኑ፣ ይጻፉ እና ያስቀምጡ።'],
    en: ['Change the labor ID right here', 'No need for Edit: click the Labor ID at the top of the profile, type it and save.'] },
  { id: 'accounts', route: '/profiles/:p', target: null,
    am: ['በየትኛው አካውንት እንደሚገባ ይምረጡ', 'እያንዳንዱ ሳጥን (LMIS፣ ሙሳነድ፣ ኢንሹራንስ፣ ቪዛ) የራሱ ትንሽ የአካውንት ቦታ አለው። ስራው በዚያ አካውንት ይገባል፤ ኮዱን እና ካፕቻውን እርስዎ ይጽፋሉ።'],
    en: ['Pick which account a run signs in with', 'Each box (LMIS, Musaned, Insurance, Visa) has its own small account slot. The run signs in with it; you type the code and the captcha.'] },
  { id: 'musaned_check', route: '/profiles/:musaned', target: 'run-musaned_check_chosen',
    am: ['ተመርጣለች ወይ? ሲስተሙ ይፈትሽ', 'Check if chosen ሙሳነድ ውስጥ በፓስፖርቷ ይፈልጋል። ከተመረጠች ምልክት ያደርጋል፣ template.pdf ን ወደ Contract ያወርዳል፣ አሰሪውን እና ኤጀንሲውን ይሞላል።'],
    en: ['Has she been chosen? Let the system check', 'Check if chosen searches Musaned by her passport. If she was chosen it marks her, downloads template.pdf into Contract and fills in the employer and the agencies.'] },
  { id: 'musaned_taken', route: '/profiles/:musaned', target: null,
    am: ['ሙሳነድ ላይ ቀድሞ ካለች', 'ቀድሞ በዝርዝራችን ካለች ሙሳነድ ራሱ ተጠናቀቀ ይባላል። በሌላ ኤጀንሲ ከተያዘች የያዛት ኤጀንሲ በማስታወሻ ይጻፋል፣ ማሳወቂያ እና ተግባር ይደርስዎታል።'],
    en: ['When she is already on Musaned', 'Already on our list: Musaned is marked done by itself. Held by another agency: that agency is written in her notes and you get a notification and a task.'] },
  { id: 'wafid_book', route: '/profiles/:p', target: 'run-wafid_book',
    am: ['የዋፊድ ቀጠሮ ይያዙ', 'Book appointment ፎርሙን ይሞላል፣ ካፕቻውን እና ክፍያውን እርስዎ ይጨርሳሉ።'],
    en: ['Book the Wafid appointment', 'Book appointment fills the form; you finish the captcha and the payment.'] },
  { id: 'wafid_slip', route: '/profiles/:p', target: 'run-wafid_slip',
    am: ['የቀጠሮ ስሊፑን ያትሙ', 'Appointment slip በwafid.com ላይ ስሊፑን ፈልጎ PDF ውን በAppointment Slip ሳጥን ውስጥ ያስቀምጣል። እዚያው 🖨 Print ይጫኑ።'],
    en: ['Print the appointment slip', 'Appointment slip finds her slip on wafid.com and saves its PDF in the Appointment Slip box. Press 🖨 Print right there.'] },
  { id: 'wafid_check', route: '/profiles/:p', target: 'run-wafid_check',
    am: ['የህክምና ውጤቱን ይፈትሹ', 'Check appointment በwafid.com ላይ በፓስፖርቷ ይፈልጋል፣ Fit ወይም Unfit መሆኗን በፕሮፋይሉ ላይ ይጽፋል።'],
    en: ['Check the medical result', 'Check appointment searches wafid.com by her passport and writes Fit or Unfit on her profile.'] },
  { id: 'insurance_run', route: '/profiles/:p', target: 'run-insurance_certificate',
    am: ['የኢንሹራንስ ሰርተፊኬት', 'ፌታፕ ውስጥ ይገባል፣ + New certificate ይጫናል፣ ቅርንጫፍ፣ ክፍለ ከተማ እና ወረዳን ከSettings ጨምሮ ይሞላል፣ Save እንዲጫኑ ይጠራዎታል።'],
    en: ['The insurance certificate', 'It signs in to FetaP, presses + New certificate, fills it (branch, sub city and woreda from Settings) and calls you to press Save.'] },
  { id: 'visa_run', route: '/profiles/:p', target: 'run-mofa_visa',
    am: ['ቪዛ (እንጃዝ)', 'visa.mofa.gov.sa ውስጥ ይገባል (ካፕቻውን እርስዎ)፣ New Application ይከፍታል፣ ፎቶን ጨምሮ ሙሉ ፎርሙን ይሞላል፣ ካፕቻ እና Save እንዲያደርጉ ይጠራዎታል።'],
    en: ['The visa (Enjaz)', 'It signs in to visa.mofa.gov.sa (you type the captcha), opens a New Application, fills the whole form with her photo and calls you for the captcha and Save.'] },
  { id: 'lmis_contract', route: '/profiles/:p', target: 'run-lmis_contract',
    am: ['የLMIS ውል', 'LMIS ውስጥ ውሉን ይሞላል፣ ሰነዶቹን ይጭናል፤ Submit የሚጫኑት እርስዎ ነዎት።'],
    en: ['The LMIS contract', 'It fills the contract in LMIS and uploads the documents; you are the one who presses Submit.'] },
  { id: 'sounds', route: '', target: null,   // any page: no need to move
    am: ['ድምፁን ይለዩ', 'ለመግባት (ካፕቻ፣ ኮድ) ሲጠራ እንደ ሰዓት ማንቂያ ይጮኻል፤ በገጹ ላይ ሲጫኑ ወይም 1 ደቂቃ ሲያልፍ ይቆማል። Submit ወይም Save ሲጠራ እያንዳንዱ ስራ የራሱ ድምፅ አለው። በዴስክቶፑ ላይም መልእክት ይወጣል።'],
    en: ['Know the sounds', 'A sign-in call (captcha, code) beeps like a watch alarm until you click on that page, or 1 minute. A call to Submit or Save rings with the task\'s own sound. Both pop up on the desktop.'] },
]
const LESSON_IDS = new Set(LESSONS.map(l => l.id))

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local

export async function getLang(db, who) {
  const r = await db('tutor_prefs').where({ who }).first()
  return r?.lang === 'en' ? 'en' : 'am'
}
export async function setLang(db, who, lang) {
  lang = lang === 'en' ? 'en' : 'am'
  const n = await db('tutor_prefs').where({ who }).update({ lang })
  if (!n) await db('tutor_prefs').insert({ who, lang })
  return lang
}

/** Record that a person used a feature (lesson id). */
export async function track(db, who, feature) {
  if (!LESSON_IDS.has(feature)) return false
  const now = new Date().toISOString()
  const n = await db('tutor_usage').where({ who, feature }).update({ count: db.raw('count + 1'), last_at: now })
  if (!n) await db('tutor_usage').insert({ who, feature, count: 1, first_at: now, last_at: now })
  // Using the feature of today's lesson completes the lesson.
  return true
}

/** The full tour: a lesson counts once it was shown ("seen:<id>") or the feature was used. */
export async function markSeen(db, who, lessonId) {
  if (!LESSON_IDS.has(lessonId)) return false
  const feature = `seen:${lessonId}`, now = new Date().toISOString()
  const n = await db('tutor_usage').where({ who, feature }).update({ count: db.raw('count + 1'), last_at: now })
  if (!n) await db('tutor_usage').insert({ who, feature, count: 1, first_at: now, last_at: now })
  return true
}

async function seenLessons(db, who) {
  const rows = await db('tutor_usage').where({ who }).select('feature')
  const out = new Set()
  for (const r of rows) {
    const id = r.feature.startsWith('seen:') ? r.feature.slice(5) : r.feature
    if (LESSON_IDS.has(id)) out.add(id)
  }
  return out
}

async function usedFeatures(db, who) {
  const rows = await db('tutor_usage').where({ who }).andWhere('count', '>', 0).select('feature')
  return new Set(rows.map(r => r.feature).filter(f => LESSON_IDS.has(f)))
}

/** Profiles to point at, from today's data. */
async function exampleProfiles(db) {
  const fileCount = (name) => db('profile_fields as pf').join('files as f', 'f.profile_field_id', 'pf.id')
    .where('pf.name', name).select('pf.profile_id').groupBy('pf.profile_id')
  const [withPhoto, withBody, withPassport, recent] = await Promise.all([
    fileCount('Photo'), fileCount('Full Body Photo'), fileCount('Passport'),
    db('profiles').orderBy('updated_at', 'desc').first('id'),
  ])
  const ids = (rows) => new Set(rows.map(r => r.profile_id))
  const photo = ids(withPhoto), body = ids(withBody), pass = ids(withPassport)
  const labor = new Set((await db('profiles').whereNotNull('labor_id').andWhere('labor_id', '!=', '').select('id')).map(r => r.id))
  const pick = (pred) => [...pass].find(pred) || recent?.id || null
  return {
    p: recent?.id || null,
    cv: [...photo].find(id => body.has(id)) || [...photo][0] || recent?.id || null,
    police: pick(id => labor.has(id) && photo.has(id)),
    musaned: [...photo].find(id => pass.has(id)) || recent?.id || null,
  }
}

function lessonOut(l, lang, ex) {
  const [title, body] = l[lang]
  const route = l.route.replace(/:(\w+)/, (_, k) => (ex?.[k] ? String(ex[k]) : ''))
  return { id: l.id, title, body, route: route.endsWith('/') && route !== '/' ? '/profiles' : route, target: l.target }
}

const TOUR_DAYS = 14
const PER_DAY = 3
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000)
const onPage = (route, page) => route.includes(':')
  ? /^\/profiles\/\d+\/?$/.test(page)
  : page.replace(/\/+$/, '') === route.replace(/\/+$/, '') || (route === '/' && page === '')

/**
 * Today's part of the tour: up to 3 lessons not known yet, the page the person
 * is on first. `show` is false once today's part was shown (or all is known).
 */
export async function tourFor(db, who, page = '') {
  const lang = await getLang(db, who)
  const seen = await seenLessons(db, who)
  const remaining = LESSONS.filter(l => !seen.has(l.id))
  const days = (await db('tutor_days').where({ who, lesson_id: 'tour' }).orderBy('day').select('day')).map(r => r.day)
  const shownToday = days.includes(today())
  const day = days.length ? daysBetween(days[0], today()) + 1 : 1
  const left = Math.max(1, TOUR_DAYS - day + 1)
  const quota = Math.min(6, Math.max(PER_DAY, Math.ceil(remaining.length / left)))
  const here = remaining.filter(l => onPage(l.route, String(page)))
  const ex = await exampleProfiles(db)
  const lessons = [...here, ...remaining.filter(l => !here.includes(l))].slice(0, quota).map(l => lessonOut(l, lang, ex))
  return {
    who, lang, show: !shownToday && lessons.length > 0, lessons,
    day: Math.min(day, TOUR_DAYS), days: TOUR_DAYS,
    seen: LESSONS.length - remaining.length, total: LESSONS.length, done: remaining.length === 0,
  }
}

/** Today's part of the tour was shown (seen through or skipped): no more today. */
export async function markTourShown(db, who) {
  const now = new Date().toISOString()
  const n = await db('tutor_days').where({ who, day: today() }).update({ lesson_id: 'tour', lesson_done: true })
  if (!n) await db('tutor_days').insert({ who, day: today(), lesson_id: 'tour', lesson_done: true, goals_done: '[]', opened_at: now }).catch(() => {})
}

/** "Ask Adal": a short how-to answer, and the lesson that shows it. */
export async function ask(db, who, question, langIn) {
  const lang = langIn === 'en' || langIn === 'am' ? langIn : await getLang(db, who)
  const ex = await exampleProfiles(db)
  const library = LESSONS.map(l => `${l.id}: ${l.en[0]} — ${l.en[1]}`).join('\n')
  const keyword = () => {
    const q = String(question).toLowerCase()
    let best = null, score = 0
    for (const l of LESSONS) {
      const words = `${l.id} ${l.en.join(' ')} ${l.am.join(' ')}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2)
      const s = words.filter(w => q.includes(w)).length
      if (s > score) { score = s; best = l }
    }
    return best
  }
  let answer = null, lessonId = null
  if (isGeminiConfigured()) {
    const system = `You are Adal, the built-in tutor of Adal Keep, an app for Ethiopian overseas-employment agencies.
Answer the user's how-to question about the app in ${lang === 'en' ? 'simple English' : 'simple Amharic (ፊደል)'}, in at most 70 words.
Only explain where to click and what happens. Never say you did something: you cannot press buttons or change data.
If the question is not about using Adal Keep, say briefly that you only help with Adal Keep.
Features:\n${library}
On the LAST line write exactly "LESSON: <id>" with the feature id that shows the answer, or "LESSON: none".`
    try {
      const out = await askGemini(system, String(question).slice(0, 500))
      const m = out.match(/LESSON:\s*([a-z_]+)/i)
      lessonId = m && LESSON_IDS.has(m[1]) ? m[1] : null
      answer = out.replace(/\n?\s*LESSON:.*$/is, '').trim()
    } catch (e) {
      console.warn('[tutor] Gemini could not answer:', e.message)
    }
  }
  const l = lessonId ? LESSONS.find(x => x.id === lessonId) : (!answer ? keyword() : null)
  if (!answer) {
    answer = l
      ? `${l[lang][0]}. ${l[lang][1]}`
      : (lang === 'en' ? 'I could not answer that right now. Try one of the lessons below.' : 'አሁን መመለስ አልቻልኩም። ከታች ካሉት ትምህርቶች አንዱን ይሞክሩ።')
  }
  return { answer, lesson: l ? lessonOut(l, lang, ex) : null, lang }
}

/** The owner's view: each person's progress. */
export async function adoption(db) {
  // Everyone the tutor has seen: employees by name, others by their browser's id.
  const names = new Map()
  try {
    for (const u of await db('users').select('id', 'name', 'username')) names.set(String(u.id), u.name || u.username)
  } catch {}
  const whos = new Set([
    ...(await db('tutor_usage').distinct('who')).map(r => r.who),
    ...(await db('tutor_days').distinct('who')).map(r => r.who),
  ])
  const people = [...whos].map(who => ({ who, name: names.get(who) || `Not signed in · ${who === 'owner' ? 'old shared' : who.replace(/^pc-/, 'PC ')}` }))
  const usage = (await db('tutor_usage').select('who', 'feature', 'last_at')).filter(u => LESSON_IDS.has(u.feature))
  const out = []
  for (const p of people) {
    const mine = usage.filter(u => u.who === p.who)
    const used = new Set(mine.map(u => u.feature))
    const last = mine.map(u => u.last_at).sort().pop() || null
    out.push({
      ...p,
      used: used.size, total: LESSONS.length,
      never: LESSONS.filter(l => !used.has(l.id)).map(l => l.en[0]),
      last_active: last,
    })
  }
  return out.sort((a, b) => b.used - a.used)
}
