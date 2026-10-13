import db from '../config/database.js'
import logger from '../utils/logger.js'

export async function createProfile(req, res) {
  try {
    // ... logic
  } catch (err) {
    logger.error('createProfile error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to create profile' })
  }
}

export async function getDashboard(req, res) {
  const branchId = req.session.branchId || 1

  try {
    const [{ count: totalProfiles }] = await db('profiles').where({ branch_id: branchId }).count()
    const [{ count: pendingProfiles }] = await db('profiles').where({ branch_id: branchId, status: 'pending' }).count()
    
    // FIX: Only count locations that are actively linked to profiles in this branch
    const [boxCountRow] = await db('physical_locations')
      .join('profiles', 'physical_locations.id', 'profiles.physical_location_id')
      .where('profiles.branch_id', branchId)
      .countDistinct('physical_locations.id as count')

    const recentActivity = await db('audit_log')
      .select('audit_log.*', 'users.full_name as user_name')
      .leftJoin('users', 'audit_log.user_id', 'users.id')
      .orderBy('created_at', 'desc')
      .limit(10)

    res.json({
      totalProfiles: Number(totalProfiles),
      pendingProfiles: Number(pendingProfiles),
      totalBoxes: Number(boxCountRow?.count || 0),
      recentActivity,
    })
  } catch (err) {
    logger.error('getDashboard error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to load dashboard metrics' })
  }
}