import { Router } from 'express'
import db from '../config/database.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const totalProfiles = await db('profiles').count('id as count').first()
    const pendingProfiles = await db('profiles').where('status', 'pending').count('id as count').first()
    const totalBoxes = await db('boxes').count('id as count').first()
    
    res.json({
      totalProfiles: totalProfiles?.count || 0,
      pendingProfiles: pendingProfiles?.count || 0,
      totalBoxes: totalBoxes?.count || 0,
      newProfiles: 0, // You can calculate this from a date filter
      recentActivity: [] // You can add activity logging later
    })
  } catch (error) {
    console.error('Dashboard stats error:', error)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

export default router