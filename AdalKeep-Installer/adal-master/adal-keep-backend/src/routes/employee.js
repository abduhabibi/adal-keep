import { Router } from 'express'

const router = Router()

router.post('/name', (req, res) => {
  const { name } = req.body
  // The client stores it; we just acknowledge.
  res.json({ success: true, name })
})

export default router