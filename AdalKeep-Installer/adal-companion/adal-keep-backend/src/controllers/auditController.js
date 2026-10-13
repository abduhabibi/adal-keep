import db from '../config/database.js'
export async function createProfile(req, res) {
  try {
    // ... logic
  } catch (err) {
    logger.error('createProfile error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to create profile' })
  }
}

export async function listAudit(req, res) {
  if (req.session.role === 'admin') {
    const entries = await db('audit_log')
      .leftJoin('users', 'audit_log.user_id', 'users.id')
      .select(
        'audit_log.id',
        'audit_log.action',
        'audit_log.entity_type',
        'audit_log.entity_id',
        'audit_log.details',
        'audit_log.created_at',
        'users.full_name as user_name',
        'users.username'
      )
      .orderBy('audit_log.created_at', 'desc')
      .limit(200)
    return res.json(entries)
  }

  const entries = await db('audit_log')
    .select('id', 'action', 'entity_type', 'entity_id', 'details', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(200)
  res.json(entries)
}
