// Copies trust.js + authority.js next to the function before deploying (see index.ts).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const from = path.join(here, '..', '..', '..', '..', 'adal-keep-backend', 'src', 'services', 'sync')
fs.mkdirSync(path.join(here, 'shared'), { recursive: true })
for (const f of ['trust.js', 'authority.js']) fs.copyFileSync(path.join(from, f), path.join(here, 'shared', f))
console.log('copied trust.js, authority.js → shared/')
