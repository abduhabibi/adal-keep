import { Router } from 'express'
import db from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Protect all routes
router.use(requireAuth)

// --- Controller Functions ---

// Get a single location by ID
const getLocation = async (req, res) => {
  try {
    const { id } = req.params
    const loc = await db('physical_locations').where({ id }).first()
    if (!loc) return res.status(404).json({ error: 'Not found' })
    return res.json(loc)
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch location' })
  }
}

// Search locations
const searchLocations = async (req, res) => {
  try {
    const { search } = req.query
    let query = db('physical_locations').select('*')
    
    if (search) {
      query = query.where(function () {
        this.where('room', 'ilike', `%${search}%`)
          .orWhere('table_name', 'ilike', `%${search}%`)
          .orWhere('box_number', 'ilike', `%${search}%`)
      })
    }
    
    const locations = await query.limit(20)
    return res.json(locations)
  } catch (error) {
    return res.status(500).json({ error: 'Failed to search locations' })
  }
}

// Create a new location
const createLocation = async (req, res) => {
  try {
    const { room, table_name, box_number } = req.body
    if (!room || !table_name || !box_number) {
      return res.status(400).json({ error: 'room, table_name, and box_number are required' })
    }

    const branchId = req.session?.branchId || 1
    const existing = await db('physical_locations')
      .where({ room, table_name, box_number, branch_id: branchId })
      .first()

    if (existing) return res.json(existing)

    const [location] = await db('physical_locations')
      .insert({ room, table_name, box_number, branch_id: branchId })
      .returning('*')

    return res.status(201).json(location)
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create location' })
  }
}

// --- Routes Definition ---

router.get('/:id', getLocation)       // Specific ID route first
router.get('/', searchLocations)      // General search route next
router.post('/', createLocation)      // Creation route

export default router
