import { Router } from 'express'
import { listAudit } from '../controllers/auditController.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.get('/', requireAuth, listAudit)

export default router
