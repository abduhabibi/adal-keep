import bcrypt from 'bcryptjs'
import { signToken, verifyToken } from '../services/tenancy.js'

const parseCookies = (req) => {
  const o = {}
  ;(req.headers.cookie || '').split(';').forEach(p => {
    const [k, ...v] = p.split('=')
    if (k) o[k.trim()] = decodeURIComponent(v.join('='))
  })
  return o
}

const setTokenCookie = (res, token) => {
  res.setHeader('Set-Cookie', `adal_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
}

export async function login(req, res) {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'መለያ ስም እና የይለፍ ቃል ያስፈልጋሉ' })
  }

  try {
    const db = req.app.locals.db
    const user = await db('users')
      .where('username', username.trim())
      .orWhere('phone_whatsapp', username.trim())
      .orWhere('phone_work', username.trim())
      .first()

    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'መለያ ስም ወይም የይለፍ ቃል ትክክል አይደለም' })
    }

    const token = signToken({
      uid: user.id,
      companyId: user.company_id,
      branchId: user.branch_id,
      role: user.role
    })
    setTokenCookie(res, token)

    res.json({
      success: true,
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    })
  } catch (err) {
    console.error('[login]', err.message)
    res.status(500).json({ error: 'መግባት አልተቻለም' })
  }
}

export async function logout(req, res) {
  res.setHeader('Set-Cookie', 'adal_token=; Path=/; HttpOnly; Max-Age=0')
  res.json({ success: true })
}

export async function getMe(req, res) {
  try {
    const db = req.app.locals.db
    const data = verifyToken(parseCookies(req).adal_token)
    if (!data) return res.status(401).json({ error: 'አልገባም' })

    let user = data.uid ? await db('users').where({ id: data.uid }).first() : null

    // Fallback for pure token-based owner (from original setup wizard)
    if (!user && data.role === 'owner') {
      user = { id: 0, name: 'Owner', role: 'owner', username: 'owner', company_id: data.companyId, branch_id: data.branchId }
    }
    if (!user) return res.status(401).json({ error: 'ተጠቃሚ አልተገኘም' })

    const company = await db('companies').where({ id: data.companyId }).first()
    const branch = await db('branches').where({ id: data.branchId }).first()

    res.json({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        username: user.username
      },
      company: company ? { id: company.id, name: company.name } : null,
      branch: branch ? { id: branch.id, name: branch.name } : null
    })
  } catch (err) {
    console.error('[me]', err.message)
    res.status(500).json({ error: 'ስህተት' })
  }
}
