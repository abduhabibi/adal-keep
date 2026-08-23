import db from '../config/database.js'

export async function logActivity(userId, action, targetType, targetId, details = {}) {
  await db('audit_log').insert({
    user_id: userId || null,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
  })
}
