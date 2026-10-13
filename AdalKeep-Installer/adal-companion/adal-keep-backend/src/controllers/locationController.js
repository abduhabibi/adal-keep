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

export async function getLocation(req, res) {
  const { id } = req.params
  const loc = await db('physical_locations').where({ id }).first()
  if (!loc) return res.status(404).json({ error: 'Not found' })
  res.json(loc)
}

// FIX: Added handler to pull only locations occupied by active profiles
export async function listLocations(req, res) {
  const branchId = req.session.branchId || 1
  try {
    const activeLocations = await db('physical_locations')
      .join('profiles', 'physical_locations.id', 'profiles.physical_location_id')
      .where('profiles.branch_id', branchId)
      .select(
        'physical_locations.id',
        'physical_locations.room',
        'physical_locations.table_name',
        'physical_locations.box_number'
      )
      .distinct()
      .orderBy('physical_locations.room', 'asc')

    res.json(activeLocations)
  } catch (err) {
    logger.error('listLocations error: ' + err.message, { stack: err.stack })
    res.status(500).json({ error: 'Failed to load locations' })
  }
}