import express from 'express'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const branches = await db('branches')
      .where({ company_id: req.auth.companyId })
      .select('id', 'name', 'location', 'created_at')
      .orderBy('created_at', 'desc')
    res.json(branches)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load branches' })
  }
})

router.post('/migrate', async (req, res) => {
  if (req.auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' })
  
  const { target_branch_id } = req.body
  if (!target_branch_id) return res.status(400).json({ error: 'Target branch is required' })

  try {
    const db = req.app.locals.db
    const count = await db('profiles')
      .where({ branch_id: req.auth.branchId, company_id: req.auth.companyId })
      .update({ branch_id: target_branch_id, updated_at: new Date().toISOString() })
    
    res.json({ success: true, migrated: count })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to migrate profiles' })
  }
})

export default router
