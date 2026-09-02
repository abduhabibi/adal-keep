import express from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { signToken, verifyToken, adoptOrphanData } from '../services/tenancy.js'
import { readSide, statusPayload, applyCode, decryptDatabase, isLockedFile } from '../services/subscription.js'

const router = express.Router()
const parseCookies = (req) => { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const [k, ...v] = p.split('='); if (k) o[k.trim()] = decodeURIComponent(v.join('=')) }); return o }
const setTokenCookie = (res, t) => res.setHeader('Set-Cookie', `adal_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)

export function attachAuth(req, res, next) { const d = verifyToken(parseCookies(req).adal_token); if (d) req.auth = d; next() }
export const requireAuth = (req, res, next) => req.auth ? next() : res.status(401).json({ error: 'መግባት ያስፈልጋል' })
export const requireOwner = (req, res, next) => req.auth?.role === 'owner' ? next() : res.status(403).json({ error: 'ለባለቤት ብቻ' })

// Phone normalization for flexible login
const normalizePhone = (p) => {
  if (!p) return null
  const digits = String(p).replace(/\D/g, '')
  if (digits.length === 0) return null
  if (digits.startsWith('251')) return '+' + digits
  if (digits.startsWith('0')) return '+251' + digits.slice(1)
  return '+' + digits
}

router.get('/setup/status', async (req, res) => {
  if (req.app.locals.destroyed || isLockedFile()) return res.json({ state: 'destroyed', subscription: statusPayload(readSide()) })
  const company = await req.app.locals.db('companies').first().catch(() => null)
  res.json({ state: company ? 'ready' : 'setup', companyName: company?.name || null, subscription: statusPayload(readSide()) })
})

router.post('/setup/company', async (req, res) => {
  const db = req.app.locals.db
  const { devPassword, companyName, ceoName, phone1, phone2, phone3, intakeNumber } = req.body
  const lic = await db('license').first()
  if (!lic || !(await bcrypt.compare(devPassword || '', lic.dev_password_hash))) return res.status(401).json({ error: 'የገንቢ የይለፍ ቃል ትክክል አይደለም' })
  if (!companyName?.trim()) return res.status(400).json({ error: 'የኩባንያ ስም ያስፈልጋል' })
  if (await db('companies').first()) return res.status(400).json({ error: 'ኩባንያ ቀድሞ ተዋቅሯል' })

  const { initSidecar } = await import('../services/subscription.js')
  if (!readSide()) initSidecar()

  const [companyId] = await db('companies').insert({
    name: companyName, owner_name: ceoName || null,
    phone1: phone1 || null, phone2: phone2 || null, phone3: phone3 || null,
    intake_phone: intakeNumber || null,
    api_key_name: `Adal ${companyName}`, api_key: crypto.randomBytes(16).toString('hex'),
  })
  const [branchId] = await db('branches').insert({ company_id: companyId, name: 'Main Branch' })
  await adoptOrphanData(db, companyId, branchId)
  setTokenCookie(res, signToken({ role: 'owner', companyId, branchId }))
  res.json({ success: true, apiKeyName: `Adal ${companyName}` })
})

router.get('/subscription/status', (req, res) => res.json(statusPayload(readSide())))

router.post('/subscription/unlock', async (req, res) => {
  const { code } = req.body
  if (!applyCode(code)) return res.status(400).json({ error: 'ልክ ያልሆነ የመዳረሻ ኮድ' })
  if (isLockedFile()) {
    await decryptDatabase()
    if (req.app.locals.runInit) await req.app.locals.runInit()
    req.app.locals.destroyed = false
  }
  res.json({ success: true, subscription: statusPayload(readSide()) })
})

router.get('/notifications', async (req, res) => {
  res.json(await req.app.locals.db('notifications').orderBy('created_at', 'desc').limit(100))
})
router.delete('/notifications/all', async (req, res) => {
  await req.app.locals.db('notifications').del()
  res.json({ success: true })
})
router.delete('/notifications/:id', async (req, res) => {
  await req.app.locals.db('notifications').where({ id: req.params.id }).del()
  res.json({ success: true })
})

// LOGIN with phone normalization
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'መለያ ስም እና የይለፍ ቃል ያስፈልጋሉ' })

  try {
    const db = req.app.locals.db
    const norm = normalizePhone(username)
    
    // Build dynamic query based on input
    const query = db('users').where('username', username.trim())
    if (norm) {
      query.orWhere('phone_work', norm)
      query.orWhere('phone_work', norm)
    }
    const user = await query.first()

    if (!user || !user.password || !(await bcrypt.compare(password || '', user.password))) {
      return res.status(401).json({ error: 'መለያ ስም ወይም የይለፍ ቃል ትክክል አይደለም' })
    }
    
    setTokenCookie(res, signToken({ 
      uid: user.id, 
      companyId: user.company_id, 
      branchId: user.branch_id, 
      role: user.role 
    }))
    res.json({ success: true, name: user.name, role: user.role })
  } catch (err) {
    console.error('[login]', err.message)
    res.status(500).json({ error: 'መግባት አልተቻለም' })
  }
})

router.post('/auth/logout', (req, res) => { res.setHeader('Set-Cookie', 'adal_token=; Path=/; HttpOnly; Max-Age=0'); res.json({ success: true }) })

router.get('/auth/me', async (req, res) => {
  const db = req.app.locals.db
  const data = verifyToken(parseCookies(req).adal_token)
  if (!data) return res.status(401).json({ error: 'አልገባም' })
  
  let user = data.uid ? await db('users').where({ id: data.uid }).first() : null
  if (!user && data.role === 'owner') user = { id: 0, name: 'Owner', role: 'owner', username: 'owner', branch_id: data.branchId }
  if (!user) return res.status(401).json({ error: 'ተጠቃሚ አልተገኘም' })
  
  const company = await db('companies').where({ id: data.companyId }).first()
  const branch = await db('branches').where({ id: data.branchId }).first()
  res.json({
    user: { id: user.id, name: user.name, role: user.role, username: user.username },
    company: company ? { id: company.id, name: company.name, apiKeyName: company.api_key_name, intakeNumber: company.intake_phone } : null,
    branch: branch ? { id: branch.id, name: branch.name } : null,
  })
})

router.post('/auth/reset-owner', async (req, res) => {
  const db = req.app.locals.db
  const { devPassword, newPassword } = req.body
  const lic = await db('license').first()
  if (!lic || !(await bcrypt.compare(devPassword || '', lic.dev_password_hash))) return res.status(401).json({ error: 'የገንቢ የይለፍ ቃል ትክክል አይደለም' })
  const company = await db('companies').first()
  const hash = await bcrypt.hash(newPassword || '', 10)
  let owner = await db('users').where({ role: 'owner' }).first()
  let username
  if (owner) {
    username = owner.username
    await db('users').where({ id: owner.id }).update({ password: hash })
  } else {
    const anyUser = await db('users').orderBy('id').first()
    if (anyUser) {
      username = anyUser.username
      await db('users').where({ id: anyUser.id }).update({ password: hash, role: 'owner' })
    } else {
      username = 'owner'
      await db('users').insert({ username: 'owner', name: 'Owner', role: 'owner', company_id: company?.id || null, password: hash })
    }
  }
  res.json({ success: true, username })
})

export default router
