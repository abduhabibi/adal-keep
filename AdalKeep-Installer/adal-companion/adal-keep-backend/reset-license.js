import dotenv from 'dotenv'
dotenv.config()

import db from './src/config/database.js'      // uses your working connection
import bcrypt from 'bcryptjs'
import { generateFingerprint } from './src/services/fingerprint.js'

const DEV_PASSWORD = '759126348'

async function main() {
  console.log('🔧 Flex License Rescue Tool\n')

  const newFingerprint = generateFingerprint()
  console.log('Current hardware fingerprint:', newFingerprint.slice(0, 16) + '...')

  const devHash = await bcrypt.hash(DEV_PASSWORD, 10)

  const existing = await db('license').first()

  if (existing) {
    await db('license').where({ id: existing.id }).update({
      fingerprint_hash: newFingerprint,
      dev_password_hash: devHash,
      last_checked: db.fn.now(),
    })
    console.log('✅ License updated with current hardware fingerprint')
  } else {
    await db('license').insert({
      fingerprint_hash: newFingerprint,
      dev_password_hash: devHash,
    })
    console.log('✅ New license created with current hardware fingerprint')
  }

  console.log('🔑 Dev password set to:', DEV_PASSWORD)
  console.log('\nServer will now start normally.')

  await db.destroy()
  process.exit(0)
}

main().catch((err) => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})