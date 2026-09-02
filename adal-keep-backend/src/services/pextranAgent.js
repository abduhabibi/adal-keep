import fs from 'fs'
import db from '../config/database.js'
import logger from '../utils/logger.js'
import braveApi from './braveAgent.js'

function api() {
  const a = braveApi?.default || braveApi
  if (typeof a.ensureBrowser !== 'function') {
    throw new Error('braveAgent.ensureBrowser missing')
  }
  if (typeof a.getOrOpenTab !== 'function') {
    throw new Error('braveAgent.getOrOpenTab missing')
  }
  return a
}

export async function findProfileByName(name) {
  const q = String(name || '').trim()
  if (!q || q.length < 2) return null
  let row = await db('profiles').whereRaw('LOWER(full_name) = ?', [q.toLowerCase()]).first()
  if (row) return row
  return db('profiles')
    .whereRaw('LOWER(full_name) LIKE ?', [`%${q.toLowerCase()}%`])
    .orderBy('id', 'desc')
    .first()
}

export async function getPassportFilePath(profileId) {
  const field = await db('profile_fields').where({ profile_id: profileId, name: 'Passport' }).first()
  if (!field) return null
  const file = await db('files').where({ profile_field_id: field.id }).orderBy('id', 'desc').first()
  if (!file?.path || !fs.existsSync(file.path)) return null
  return file.path
}

export async function createPextranTask(profile, stage, extra = {}) {
  const title =
    stage === 'click_next'
      ? `Pextran፡ Next ያጽድቁ — ${profile.full_name}`
      : `Pextran፡ ${profile.full_name}`
  const [id] = await db('tasks').insert({
    title,
    description: 'በPextran ላይ Next ለመጫን ያጽድቁ። Submit በራሱ አይጫንም።',
    type: 'ai_pextran',
    status: 'pending',
    priority: 'high',
    profile_id: profile.id,
    is_ai_created: 1,
    created_by: 'AI',
    payload: JSON.stringify({ stage, profile_id: profile.id, full_name: profile.full_name, ...extra }),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })
  return id
}

export async function startNewRecruit(profileName) {
  const profile = await findProfileByName(profileName)
  if (!profile) return { ok: false, error: `ፕሮፋይል አልተገኘም፡ ${profileName}` }

  const passportPath = await getPassportFilePath(profile.id)
  if (!passportPath) {
    return { ok: false, error: `ለ ${profile.full_name} የፓስፖርት ፋይል የለም` }
  }

  const { ensureBrowser, getOrOpenTab, startAgent } = api()

  // Open Brave but do NOT auto-open Pextran (AI will navigate when needed)
  try {
    if (typeof startAgent === 'function') await startAgent({ openPextran: false })
  } catch (e) {
    logger.warn('[pextran] startAgent: ' + e.message)
  }

  const browser = await ensureBrowser()
  if (!browser) return { ok: false, error: 'Brave አልተከፈተም' }

  // Go to main Pextran page first, then click "Recruits" in left sidebar as requested
  let page = await getOrOpenTab(
    browser,
    ['pextran.com', 'agency.pextran', 'zadulmead'],
    'https://zadulmead.agency.pextran.com'
  )

  // Force navigation to New Recruits page (more reliable than clicking sidebar/right button)
  try {
    await page.goto('https://zadulmead.agency.pextran.com/recruits/new', {
      waitUntil: 'networkidle0',
      timeout: 30000
    })
    logger.info('[pextran] Navigated directly to New Recruits page')
  } catch (e) {
    logger.warn('[pextran] direct navigation failed, trying alternative:', e.message)
    try {
      await page.goto('https://zadulmead.agency.pextran.com/recruits/new/registration', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } catch (e2) {
      logger.warn('[pextran] all navigation attempts failed:', e2.message)
    }
  }

  // For fresh/new recruit flow we go straight to upload page (search is for existing profiles)
  logger.info(`[pextran] Starting new recruit flow for ${profile.full_name}`)

  // Grab passport from the specific profile and upload it
  try {
    const input = await page.$('input[type=file], input[accept*="pdf"], input[accept*="image"]')
    if (input && passportPath) {
      await input.uploadFile(passportPath)
      await new Promise(r => setTimeout(r, 2500))
      logger.info(`[pextran] Successfully uploaded passport for ${profile.full_name}`)
    } else {
      logger.warn('[pextran] Could not find upload input or passport file')
    }
  } catch (e) {
    logger.warn('[pextran] passport upload error:', e.message)
  }

  const taskId = await createPextranTask(profile, 'click_next', { passportPath })

  return {
    ok: true,
    message: `Pextran ተከፍቷል። ፓስፖርት ተጫኗል። አሁን "Next" ይጫኑ (ቀጣይ ደረጃዎች AI ይጨርሳል)`,
    taskId,
    profileId: profile.id
  }
}

export async function approvePextranNext(task) {
  let payload = {}
  try { payload = task.payload ? JSON.parse(task.payload) : {} } catch {}

  const { ensureBrowser, getOrOpenTab } = api()
  const browser = await ensureBrowser()
  if (!browser) throw new Error('Brave አልተከፈተም')

  const page = await getOrOpenTab(browser, ['pextran.com'], null)
  if (!page) throw new Error('No Pextran tab')

  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button,a,input[type=button],input[type=submit]')]
    const next = els.find(el => {
      const t = (el.textContent || el.value || '').trim().toLowerCase()
      if (/submit|finish|complete|confirm/i.test(t)) return false
      return /next|continue|ቀጣይ/i.test(t)
    })
    if (next) { next.click(); return true }
    return false
  })

  if (payload.profile_id) {
    const profile = await db('profiles').where({ id: payload.profile_id }).first()
    if (profile) {
      await page.evaluate((data) => {
        const set = (sels, value) => {
          if (!value) return
          for (const sel of sels) {
            const el = document.querySelector(sel)
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
              el.focus()
              el.value = value
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              return
            }
          }
        }
        set(['input[name*=full_name i]', 'input[name*=fullName i]'], data.full_name)
        set(['input[name*=passport i]'], data.passport_number)
        set(['input[type=tel]', 'input[name*=phone i]'], data.phone_number)
      }, {
        full_name: profile.full_name,
        passport_number: profile.passport_number,
        phone_number: profile.phone_number
      })
    }
  }

  await db('tasks').where({ id: task.id }).update({
    status: 'completed',
    updated_at: new Date().toISOString()
  })

  if (payload.profile_id) {
    const profile = await db('profiles').where({ id: payload.profile_id }).first()
    if (profile) await createPextranTask(profile, 'click_next', { after: 'step' })
  }

  return {
    ok: true,
    message: clicked ? 'Next ተጭኗል።' : 'Next አልተገኘም — Pextran ይመልከቱ።'
  }
}

export default { startNewRecruit, approvePextranNext, findProfileByName, createPextranTask }
