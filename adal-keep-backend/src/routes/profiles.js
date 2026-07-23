import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import multer from 'multer'
import { addField, updateField, deleteField, uploadFile, listFieldTemplates } from '../controllers/fieldController.js'
import { 
  listProfiles, 
  createProfile, 
  getProfile, 
  updateProfile, 
  startEditing, 
  deleteProfile,
  uploadProfilePhoto,
  getProfilePhoto,
  deleteProfilePhoto
} from '../controllers/profileController.js'

const upload = multer({ storage: multer.memoryStorage() })
const router = Router()

router.use(requireAuth)

router.get('/templates', listFieldTemplates)
router.get('/', listProfiles)
router.post('/', createProfile)
router.get('/:id', getProfile)
router.put('/:id', updateProfile)
router.post('/:id/editing', startEditing)
router.delete('/:id', deleteProfile)
router.post('/:profile_id/fields', addField)
router.put('/:profile_id/fields/:fieldId', updateField)
router.delete('/:profile_id/fields/:fieldId', deleteField)
router.post('/:profile_id/fields/:fieldId/upload', upload.single('file'), uploadFile)

// Profile photo routes
router.post('/:id/photo', upload.single('photo'), uploadProfilePhoto)
router.get('/:id/photo', getProfilePhoto)
router.delete('/:id/photo', deleteProfilePhoto)

export default router