/**
 * Demo runs — the Musaned and police clearance workflows, step by step, with
 * the same statuses, pause reasons and log lines the real runs produce. Each
 * run also carries a `view`: what its browser tab shows, drawn by DemoBrowser.
 */

export const WORKFLOWS = [
  {
    id: 'police_certificate', name: 'Make Police Certificate',
    description: 'LMIS → Organizations → EOW → Police Certificate → Add New → uploads',
    target: 'https://lmis.gov.et', consts: {}, stepCount: 9,
  },
  {
    id: 'musaned_add_candidate', name: 'Add Candidate on Musaned',
    description: 'Log in to Musaned (you solve reCAPTCHA + OTP), then auto-click agency → ADD NEW CANDIDATE → fill the pre-check form',
    target: 'https://tawtheeq.musaned.com.sa', consts: {}, stepCount: 4,
  },
]

export const MAX_RUNS = 3
const listeners = new Set()
export const onRunsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
const emit = () => listeners.forEach(fn => { try { fn() } catch {} })

const now = () => new Date().toISOString()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function log(run, msg, level = 'info') {
  run.log.push({ ts: now(), level, msg: `[run=${run.id}] ${msg}` })
  run.updated_at = now()
  emit()
}
function field(run, label, value, state = 'filled') {
  const f = run.view.fields.find(x => x.label === label)
  if (f) Object.assign(f, { value, state }); else run.view.fields.push({ label, value, state })
  emit()
}

/** What a profile is missing for a workflow (same rules as the real preflight). */
export function missingFor(db, workflowId, profile) {
  const has = (name) => db.files.some(f => f.profile_id === profile.id && f.field === name)
  const miss = []
  if (workflowId === 'police_certificate') {
    if (!profile.labor_id) miss.push('Labor ID')
    if (!has('Passport')) miss.push('Passport file')
    if (!has('Photo')) miss.push('Photo')
  } else {
    if (!profile.passport_number) miss.push('Passport number')
    if (!has('Photo')) miss.push('Personal photo')
    if (!profile.religion) miss.push('Religion')
  }
  return miss
}

// ---------------------------------------------------------------------------
// The two workflows. Each is a list of stages; a stage returning a string
// pauses the run with that pause_reason until the person continues.
// ---------------------------------------------------------------------------
const SKILL_LABEL = { cleaning: 'Cleaning', ironing: 'Ironing', washing: 'Washing', baby_sitting: 'Babysitting', cooking: 'Cooking', elderly_care: 'Elderly care' }

const STAGES = {
  police_certificate: [
    async (run, p) => {
      run.view = { site: 'lmis', url: 'lmis.gov.et/login', title: 'LMIS — sign in', fields: [], banner: null }
      log(run, '▶ Working in its own browser tab')
      await sleep(900)
      field(run, 'Username', 'agency.demo'); await sleep(500)
      field(run, 'Password', '••••••••'); await sleep(500)
      log(run, 'Sign In clicked — the portal is slow, waiting'); await sleep(2200)
      log(run, 'No answer after 20s — clicking Sign In again', 'warn'); await sleep(1400)
      log(run, 'Logged in ✓', 'success')
    },
    async (run, p) => {
      run.view = { site: 'lmis', url: 'lmis.gov.et/organizations/eow/police-certificate/new', title: 'Police Certificate — Add New', fields: [], banner: null }
      log(run, 'Organizations → EOW → Police Certificate → Add New'); await sleep(1200)
      field(run, 'Labor ID', p.labor_id); await sleep(700)
      log(run, `Found ${p.full_name} (placed)`, 'success'); await sleep(600)
      field(run, 'Full name', p.full_name, 'readonly')
      field(run, 'Passport (PDF)', 'attaching…', 'loading'); await sleep(400)
      log(run, 'File chooser caught — no Windows file window opens')
      await sleep(1500)
      field(run, 'Passport (PDF)', '✓ passport.pdf — Upload Complete')
      log(run, 'Passport attached ✓ (checked it really arrived)', 'success')
      field(run, 'Photo', 'attaching…', 'loading'); await sleep(1300)
      field(run, 'Photo', '✓ photo.jpg — Upload Complete')
      log(run, 'Photo attached ✓', 'success'); await sleep(400)
      field(run, 'Destination country', p.destination_country || 'Saudi Arabia')
      log(run, `Destination Country: ${p.destination_country || 'Saudi Arabia'} ✓`); await sleep(400)
      field(run, 'Phone', p.phone_number || '0911000000'); await sleep(500)
      run.view.banner = { kind: 'wait', text: 'Everything is filled. A person checks it and presses Submit Request.' }
      log(run, '⏸ Waiting for you: check the form and press Submit Request', 'warn')
      return 'awaiting-human-submit'
    },
  ],
  musaned_add_candidate: [
    async (run, p) => {
      run.view = { site: 'musaned', url: 'musaned.com.sa/login', title: 'Musaned — sign in', fields: [], banner: null }
      log(run, '▶ Working in its own browser tab'); await sleep(900)
      field(run, 'Username', 'office.demo'); await sleep(400)
      field(run, 'Password', '••••••••'); await sleep(400)
      run.view.banner = { kind: 'wait', text: 'reCAPTCHA: solve it in this tab, then press "I solved the captcha — continue" in Adal Keep.' }
      log(run, '⏸ reCAPTCHA on screen — waiting for you', 'warn')
      return 'awaiting-musaned-captcha'
    },
    async (run, p) => {
      run.view = { site: 'musaned', url: 'musaned.com.sa/agency/candidates/new', title: 'Add new candidate', fields: [], banner: null }
      log(run, 'Signed in ✓ → agency → ADD NEW CANDIDATE', 'success'); await sleep(1100)
      field(run, 'Full name', p.full_name); await sleep(450)
      field(run, 'Passport number', p.passport_number); await sleep(450)
      field(run, 'Date of birth', p.date_of_birth); await sleep(450)
      field(run, 'Religion', p.religion); await sleep(450)
      field(run, 'Job', 'list still loading…', 'loading')
      log(run, 'Job list still loading — will check again at the end', 'warn'); await sleep(450)
      field(run, 'Children', String(p.children_count ?? 0)); await sleep(450)
      field(run, 'Personal photo', 'uploading…', 'loading')
      log(run, 'Personal photo: uploading the Photo file (not the passport crop)'); await sleep(1500)
      field(run, 'Personal photo', '✓ uploaded', 'photo')
      log(run, 'Personal photo uploaded ✓', 'success')
      let skills = {}
      try { skills = JSON.parse(p.skills || '{}') } catch {}
      const chips = []
      for (const k of Object.keys(skills).filter(k => skills[k])) {
        chips.push(SKILL_LABEL[k] || k)
        field(run, 'Skills', chips.join(' · '))
        log(run, `Skill "${SKILL_LABEL[k] || k}" + Tab ✓`); await sleep(500)
      }
      if (p.work_experience === 'Have experience') {
        field(run, 'Experience country', p.experience_country || '—'); await sleep(400)
        field(run, 'Years of experience', String(p.experience_years || 1)); await sleep(400)
      } else {
        field(run, 'Work experience', 'No experience'); await sleep(400)
      }
      log(run, 'Final check: reading every field back…'); await sleep(1100)
      log(run, 'Job was empty (slow list) — filling it now', 'warn')
      field(run, 'Job', 'Domestic worker'); await sleep(600)
      log(run, 'All fields verified ✓', 'success')
      run.view.banner = { kind: 'wait', text: 'Every field is filled and checked. A person reviews it and presses SAVE.' }
      log(run, '⏸ Waiting for you: check the form and press SAVE', 'warn')
      return 'awaiting-human-save'
    },
  ],
}

/** Drive a run from its current stage until it pauses or finishes. */
export async function drive(db, run, save) {
  const profile = db.profiles.find(p => p.id === run.profile_id)
  const stages = STAGES[run.workflow_id]
  run.status = 'running'; run.pause_reason = null; run.updated_at = now()
  save(); emit()
  try {
    while (run.current_step < stages.length) {
      const pause = await stages[run.current_step](run, profile)
      if (run.status === 'cancelled') return
      run.current_step++
      if (pause) {
        run.status = 'paused'; run.pause_reason = pause; run.updated_at = now()
        save(); emit(); return
      }
      save()
    }
    finish(run)
    save(); emit()
  } catch (e) {
    run.status = 'failed'; run.pause_reason = String(e.message || e); save(); emit()
  }
}

export function finish(run) {
  run.status = 'done'; run.pause_reason = null
  run.finished_at = now(); run.updated_at = now()
  if (run.view) run.view.banner = { kind: 'done', text: 'Done.' }
  log(run, '✅ Run complete', 'success')
}
