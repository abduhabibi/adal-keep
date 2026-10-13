import { Router } from 'express'

const router = Router()

router.get('/check', (req, res) => {
  res.json({ valid: true })
})

// Change dev password (requires old dev password, NOT admin login)
router.put('/dev-password', async (req, res) => {
  const { oldPassword, newPassword } = req.body
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'oldPassword and newPassword required' })
  }
  try {
    await changeDevPassword(oldPassword, newPassword)
    res.json({ message: 'Dev password updated' })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router