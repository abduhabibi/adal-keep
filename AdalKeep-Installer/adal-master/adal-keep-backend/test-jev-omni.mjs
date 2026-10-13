import 'dotenv/config'
import Replicate from 'replicate'

const token = process.env.REPLICATE_API_TOKEN
if (!token) {
  console.error('❌ REPLICATE_API_TOKEN not set in .env')
  process.exit(1)
}

console.log('🔑 token loaded:', token.slice(0, 8) + '...')

const tinyRedPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQoz2P8z8Dwn4EIwDiqkL4KAY' +
  'wdEf8nZ+JkAAAAAElFTkSuQmCC'

const replicate = new Replicate({ auth: token })
const MODEL =
  'barakplasma/jev-omni:3c3225d6693fdeea3caf9a65d840270abb4cf9516ebe118f817a5061021d0f2d'

console.log('🔄 calling Jev Omni...')
try {
  const start = Date.now()
  const output = await replicate.run(MODEL, {
    input: {
      image_base64: tinyRedPngBase64,
      question: 'What color is the dominant pixel?',
      question_type: 'choice',
      options_json: JSON.stringify(['red', 'blue', 'green', 'white']),
    },
  })
  const secs = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`✅ Response in ${secs}s:`)
  console.log(JSON.stringify(output, null, 2))
} catch (e) {
  console.error('❌ Call failed:', e.message)
  if (/unauthorized|401/.test(e.message)) console.error('   → token is invalid or expired')
  if (/payment|402/.test(e.message)) console.error('   → account has no credit')
  if (/not found|404/.test(e.message)) console.error('   → model id is wrong')
  process.exit(1)
}
