/**
 * tutor.js — the daily in-app tutor.
 *
 * Each day, for each person (employee id, or 'owner'):
 *   - one LESSON: a feature they have not used yet, picked by JEV from a fixed
 *     list (a typed choice the app acts on), or by simple rules when JEV is
 *     unavailable. "Show me" opens the page and points at the real button.
 *   - up to two GOALS from today's real work (runs waiting for a person,
 *     a profile ready for its CV).
 *   - a STREAK: days in a row with at least one goal done.
 * "Ask Adal" answers how-to questions with Gemini, in Amharic or English, and
 * points to the matching lesson. The tutor only explains and points: it never
 * presses buttons, starts runs or changes data.
 */
import { askJev } from './jev/client.js'
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
    en: ['Make a CV from the profile', 'When a profile has a photo, a full-body photo, a labor ID and skills, Create CV builds the CV for you.'] },
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
    am: ['ሁልጊዜ የቅርብ ጊዜውን ይጠቀሙ', 'Check updates አዲሱን አዳል ኪፕ ያለ USB ይጭናል።'],
    en: ['Stay up to date', 'Check updates installs the newest Adal Keep without the USB.'] },
]
const LESSON_IDS = new Set(LESSONS.map(l => l.id))

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
const dayBefore = (d) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() - 1); return t.toLocaleDateString('en-CA') }

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
  await db('tutor_days').where({ who, day: today(), lesson_id: feature }).update({ lesson_done: true })
  return true
}

/** The full tour: a lesson counts once it was shown ("seen:<id>") or the feature was used. */
export async function markSeen(db, who, lessonId) {
  if (!LESSON_IDS.has(lessonId)) return false
  const feature = `seen:${lessonId}`, now = new Date().toISOString()
  const n = await db('tutor_usage').where({ who, feature }).update({ count: db.raw('count + 1'), last_at: now })
  if (!n) await db('tutor_usage').insert({ who, feature, count: 1, first_at: now, last_at: now })
  await db('tutor_days').where({ who, day: today(), lesson_id: lessonId }).update({ lesson_done: true })
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

/** Today's work that needs a person: becomes the day's goals. */
async function dataGoals(db, lang) {
  const t = (am, en) => (lang === 'en' ? en : am)
  const goals = []
  const waiting = await db('automation_queue').where('status', 'paused').orderBy('updated_at', 'desc').select('id', 'profile_id', 'pause_reason')
  if (waiting.length) {
    goals.push({ id: 'runs', text: t(`እርስዎን የሚጠብቁ ${waiting.length} ስራዎችን ይጨርሱ`, `Finish ${waiting.length} run${waiting.length > 1 ? 's' : ''} waiting for you`), route: `/profiles/${waiting[0].profile_id}`, open: waiting.length })
  }
  // No "approve tasks" goal: new documents are filed (and their tasks approved) by themselves.
  if (goals.length < 2) {
    const ex = await exampleProfiles(db)
    if (ex.cv) {
      const p = await db('profiles').where('id', ex.cv).first('id', 'full_name')
      const hasCv = await db('generated_cvs').where('profile_id', ex.cv).first('id').catch(() => null)
      if (p && !hasCv) goals.push({ id: `cv-${p.id}`, text: t(`ለ${p.full_name} ሲቪ ያዘጋጁ`, `Make the CV for ${p.full_name}`), route: `/profiles/${p.id}`, open: 1 })
    }
  }
  return goals.slice(0, 2)
}

/** The lesson for today: JEV chooses among unused features; rules otherwise. */
async function chooseLesson(db, who, used, goals) {
  const todo = LESSONS.filter(l => !used.has(l.id))
  if (!todo.length) return LESSONS[(new Date().getDate()) % LESSONS.length].id   // all used: a refresher
  if (todo.length === 1) return todo[0].id
  // Done lessons from earlier days stay out unless nothing else is left.
  const past = new Set((await db('tutor_days').where({ who, lesson_done: true }).select('lesson_id')).map(r => r.lesson_id))
  const fresh = todo.filter(l => !past.has(l.id))
  const pool = fresh.length ? fresh : todo
  const jev = await askJev(
    { role: who === 'owner' ? 'agency owner' : 'agency employee', features_used: [...used], todays_work: goals.map(g => g.text) },
    { lesson: { type: 'Choice', options: pool.map(l => l.id), instructions: 'Which ONE feature of this recruitment-agency app should this person learn today to get the most out of it? Prefer features they have never used that today\'s work needs.' } },
    { timeoutMs: 8000 },
  ).catch(() => null)
  const pick = jev?.ok ? jev.answers?.lesson?.choice : null
  if (pick && pool.some(l => l.id === pick)) return pick
  return pool[0].id   // the library is ordered from most to least useful
}

async function streakOf(db, who) {
  const rows = await db('tutor_days').where({ who }).orderBy('day', 'desc').limit(400).select('day', 'lesson_done', 'goals_done')
  const active = new Set(rows.filter(r => r.lesson_done || (JSON.parse(r.goals_done || '[]').length)).map(r => r.day))
  let d = today()
  if (!active.has(d)) d = dayBefore(d)     // today not done yet: the streak still counts
  let n = 0
  while (active.has(d)) { n++; d = dayBefore(d) }
  return { days: n, todayDone: active.has(today()) }
}

/** Everything the daily card shows. */
export async function todayFor(db, who) {
  const lang = await getLang(db, who)
  const used = await usedFeatures(db, who)
  const goals = await dataGoals(db, lang)
  let row = await db('tutor_days').where({ who, day: today() }).first()
  if (row && !LESSON_IDS.has(row.lesson_id)) {
    // A lesson that was removed from the library: pick today's again.
    await db('tutor_days').where({ id: row.id }).update({ lesson_id: await chooseLesson(db, who, used, goals), lesson_done: false })
    row = await db('tutor_days').where({ id: row.id }).first()
  }
  if (!row) {
    const lesson_id = await chooseLesson(db, who, used, goals)
    await db('tutor_days').insert({ who, day: today(), lesson_id, lesson_done: false, goals_done: '[]', opened_at: new Date().toISOString() }).catch(() => {})
    row = await db('tutor_days').where({ who, day: today() }).first()
  }
  const done = new Set(JSON.parse(row.goals_done || '[]'))
  const lessonDef = LESSONS.find(l => l.id === row.lesson_id) || LESSONS[0]
  const lesson = { ...lessonOut(lessonDef, lang, await exampleProfiles(db)), done: !!row.lesson_done }
  const goalList = [
    { id: 'lesson', text: (lang === 'en' ? 'Learn: ' : 'ይማሩ፦ ') + lesson.title, done: lesson.done, lesson: true },
    ...goals.map(g => ({ ...g, done: done.has(g.id) })),
  ]
  return {
    who, lang, day: row.day,
    lesson,
    goals: goalList,
    allDone: goalList.every(g => g.done),
    streak: await streakOf(db, who),
    progress: { used: LESSONS.filter(l => used.has(l.id)).length, total: LESSONS.length },
    tour: await (async () => {
      const seen = await seenLessons(db, who)
      const ex = await exampleProfiles(db)
      const remaining = LESSONS.filter(l => !seen.has(l.id)).map(l => lessonOut(l, lang, ex))
      return { total: LESSONS.length, seen: LESSONS.length - remaining.length, remaining, done: remaining.length === 0 }
    })(),
    ai: { jev: !!(await import('./jev/client.js')).isEnabled(), gemini: isGeminiConfigured() },
  }
}

export async function markGoal(db, who, goalId) {
  const row = await db('tutor_days').where({ who, day: today() }).first()
  if (!row) return
  if (goalId === 'lesson') {
    await db('tutor_days').where({ id: row.id }).update({ lesson_done: true })
    if (row.lesson_id) await track(db, who, row.lesson_id)
    return
  }
  const done = new Set(JSON.parse(row.goals_done || '[]')); done.add(String(goalId))
  await db('tutor_days').where({ id: row.id }).update({ goals_done: JSON.stringify([...done]) })
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
  const people = [{ who: 'owner', name: 'Owner (no employee signed in)' }]
  try {
    const users = await db('users').select('id', 'name', 'username')
    for (const u of users) people.push({ who: String(u.id), name: u.name || u.username })
  } catch {}
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
      streak: (await streakOf(db, p.who)).days,
      last_active: last,
    })
  }
  return out.filter(p => p.who !== 'owner' || p.used > 0 || p.streak > 0)
}
