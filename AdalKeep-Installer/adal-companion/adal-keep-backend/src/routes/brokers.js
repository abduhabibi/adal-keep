import { Router } from 'express'
import {
  listBrokers,
  createBroker,
  updateBroker,
  deleteBroker,
  assignBroker,
  unassignBroker
} from '../controllers/brokerController.js'

const router = Router()

router.get('/', listBrokers)
router.post('/', createBroker)
router.put('/:id', updateBroker)
router.delete('/:id', deleteBroker)
router.post('/assign', assignBroker)
router.post('/unassign', unassignBroker)

export default router