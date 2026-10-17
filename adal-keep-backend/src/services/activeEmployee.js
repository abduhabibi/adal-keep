// src/services/activeEmployee.js
// Tracks which employee (staff account) is currently bound to this machine so
// records created by the AI pipeline can be attributed to the right person.
// Stored in the `settings` key/value table; falls back to the users.device_serial
// binding (written by device-login) when settings are unavailable.

const KEY_ID = 'active_employee_id'
const KEY_NAME = 'active_employee_name'

async function upsertSetting(db, key, value) {
  const now = new Date().toISOString()
  const existing = await db('settings').where({ key }).first()
  if (existing) {
    await db('settings').where({ key }).update({ value, updated_at: now })
  } else {
    await db('settings').insert({ key, value, created_at: now, updated_at: now })
  }
}

// Called on device-login / device-resume — marks this machine's operator.
export async function setActiveEmployee(db, user) {
  if (!db || !user) return
  try {
    await upsertSetting(db, KEY_ID, user.id != null ? String(user.id) : null)
    await upsertSetting(db, KEY_NAME, user.name || user.username || null)
  } catch (e) {
    console.warn('[activeEmployee] set failed:', e.message)
  }
}

// Called on device-logout — the machine has no operator.
export async function clearActiveEmployee(db) {
  if (!db) return
  try {
    await db('settings')
      .whereIn('key', [KEY_ID, KEY_NAME])
      .update({ value: null, updated_at: new Date().toISOString() })
  } catch (e) {
    console.warn('[activeEmployee] clear failed:', e.message)
  }
}

// Resolve the current operator as { id, name } (or null).
export async function getActiveEmployee(db) {
  if (!db) return null

  // 1. Explicit setting written at device-login / device-resume
  try {
    const idRow = await db('settings').where({ key: KEY_ID }).first()
    const nameRow = await db('settings').where({ key: KEY_NAME }).first()
    const id = idRow?.value || null
    const name = nameRow?.value || null
    if (id || name) return { id: id ? Number(id) : null, name: name || null }
  } catch {
    // settings table may not exist yet — fall through to the device binding
  }

  // 2. Fallback: whichever staff account is bound to a device on this machine
  try {
    const u = await db('users')
      .whereNotNull('device_serial')
      .orderBy('updated_at', 'desc')
      .first()
    if (u) return { id: u.id, name: u.name || u.username || null }
  } catch {
    // users.device_serial column may not exist yet
  }

  return null
}
