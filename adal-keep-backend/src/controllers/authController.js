import db from '../config/database.js'
import { comparePassword } from '../utils/hash.js'
export async function createProfile(req, res) {
  try {
    // ... logic
  } catch (err) {
    logger.error('createProfile error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to create profile' })
  }
}

export async function login(req, res) {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  const user = await db('users')
    .where({ username, is_active: true })
    .first()

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const valid = await comparePassword(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  req.session.userId = user.id
  req.session.role = user.role
  req.session.branchId = user.branch_id

  res.json({
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
  })
}

export async function logout(req, res) {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' })
    res.clearCookie('connect.sid')
    res.json({ message: 'Logged out' })
  })
}

export async function getMe(req, res) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  if (req.session.isDeveloper) {
    return res.json({
      id: 0,
      username: 'developer',
      full_name: 'Developer',
      role: 'admin',
    })
  }

  const user = await db('users')
    .select('id', 'username', 'full_name', 'role')
    .where({ id: req.session.userId })
    .first()

  if (!user) {
    return res.status(401).json({ error: 'User not found' })
  }

  res.json(user)
}
