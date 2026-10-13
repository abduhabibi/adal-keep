import db from '../config/database.js'
import { hashPassword, comparePassword } from '../utils/hash.js'
import logger from '../utils/logger.js'

export async function createProfile(req, res) {
  try {
    // ... logic
  } catch (err) {
    logger.error('createProfile error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to create profile' })
  }
}

export async function deleteUser(req, res) {
  // Check authorization first
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const userId = parseInt(req.params.id, 10)
  
  // Prevent self‑deletion
  if (req.session.userId === userId) {
    return res.status(403).json({ error: 'You cannot delete your own account' })
  }

  try {
    // 1. Nullify references in dependent tables to detach data from the deleted user
    await db('field_templates').where({ created_by: userId }).update({ created_by: null })
    await db('profiles').where({ created_by: userId }).update({ created_by: null })
    await db('profile_fields').where({ created_by: userId }).update({ created_by: null })
    await db('files').where({ uploaded_by: userId }).update({ uploaded_by: null })

    // 2. Delete related audit logs to clear foreign key ties
    await db('audit_log').where({ user_id: userId }).del()

    // 3. Delete the user record
    const deletedCount = await db('users').where({ id: userId }).del()
    if (deletedCount === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    res.json({ message: 'User deleted successfully' })
  } catch (err) {
    logger.error('deleteUser error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Database operation failed during deletion' })
  }
}

export async function resetPassword(req, res) {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' })
  }
  
  const { userId, newPassword, confirmPassword } = req.body
  if (!userId) return res.status(400).json({ error: 'User ID is required' })
  if (!newPassword || !confirmPassword) return res.status(400).json({ error: 'Password fields are required' })
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' })
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

  try {
    const hash = await hashPassword(newPassword)
    await db('users').where({ id: userId }).update({ password_hash: hash })
    res.json({ message: 'Password updated successfully' })
  } catch (err) {
    logger.error('resetPassword error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to reset password' })
  }
}

export async function listUsers(req, res) {
  try {
    const users = await db('users')
      .select('id', 'username', 'full_name', 'role', 'is_active', 'created_at')
      .orderBy('created_at', 'asc')
    res.json(users)
  } catch (err) {
    logger.error('listUsers error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to retrieve users list' })
  }
}

export async function createEmployee(req, res) {
  const { username, password, full_name } = req.body
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    const existing = await db('users').where({ username }).first()
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' })
    }

    const passwordHash = await hashPassword(password)
    const [newUser] = await db('users')
      .insert({
        branch_id: req.session.branchId || 1,
        role: 'employee',
        username,
        password_hash: passwordHash,
        full_name,
        is_verified: true,
        is_active: true,
      })
      .returning(['id', 'username', 'full_name', 'role', 'is_active'])

    res.status(201).json(newUser)
  } catch (err) {
    logger.error('createEmployee error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to create employee account' })
  }
}

export async function updateMe(req, res) {
  const userId = req.session.userId
  const { username, password, full_name } = req.body

  const updates = {}
  if (username) updates.username = username
  if (full_name) updates.full_name = full_name
  if (password) updates.password_hash = await hashPassword(password)

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' })
  }

  try {
    await db('users').where({ id: userId }).update(updates)
    const user = await db('users')
      .select('id', 'username', 'full_name', 'role')
      .where({ id: userId })
      .first()
    res.json(user)
  } catch (err) {
    logger.error('updateMe error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to update account data' })
  }
}

export async function updateUserById(req, res) {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const { id } = req.params
  const { username, password, full_name, is_active } = req.body

  const updates = {}
  if (username) updates.username = username
  if (full_name) updates.full_name = full_name
  if (password) updates.password_hash = await hashPassword(password)
  if (typeof is_active === 'boolean') updates.is_active = is_active

  try {
    await db('users').where({ id }).update(updates)
    const user = await db('users')
      .select('id', 'username', 'full_name', 'role', 'is_active')
      .where({ id })
      .first()
    res.json(user)
  } catch (err) {
    logger.error('updateUserById error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to update user metrics' })
  }
}

export async function changeOwnPassword(req, res) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  
  const { oldPassword, newPassword, confirmPassword } = req.body
  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'All password fields are required' })
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' })
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }

  try {
    const user = await db('users').where({ id: req.session.userId }).first()
    if (!user) return res.status(404).json({ error: 'User not found' })

    const valid = await comparePassword(oldPassword, user.password_hash)
    if (!valid) {
      return res.status(400).json({ error: 'Current password is incorrect' })
    }

    const hash = await hashPassword(newPassword)
    await db('users').where({ id: req.session.userId }).update({ password_hash: hash })
    res.json({ message: 'Password changed successfully' })
  } catch (err) {
    logger.error('changeOwnPassword error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to alter password' })
  }
}