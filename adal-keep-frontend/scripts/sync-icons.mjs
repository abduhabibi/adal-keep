// Copies Adal Keep's icon set (src/lib/icons.js) into Adal Keep Admin
// (adal-admin/public/index.html) as an SVG sprite, so an icon changed once
// changes everywhere: `node scripts/sync-icons.mjs`. The PC app, the
// Companion and the phone app use src/lib/icons.js directly.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ICONS } from '../src/lib/icons.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADMIN = path.resolve(HERE, '../../adal-admin/public/index.html')
const symbols = Object.entries(ICONS).map(([n, body]) => `<symbol id="i-${n}" viewBox="0 0 24 24">${body}</symbol>`).join('')
const sprite = `<!-- adal-icons (from adal-keep-frontend/src/lib/icons.js: node scripts/sync-icons.mjs) --><svg xmlns="http://www.w3.org/2000/svg" style="display:none" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${symbols}</svg><!-- /adal-icons -->`
let html = fs.readFileSync(ADMIN, 'utf8')
html = /<!-- adal-icons[\s\S]*?<!-- \/adal-icons -->/.test(html)
  ? html.replace(/<!-- adal-icons[\s\S]*?<!-- \/adal-icons -->/, sprite)
  : html.replace(/<body([^>]*)>/, `<body$1>\n${sprite}`)
fs.writeFileSync(ADMIN, html)
console.log(`${Object.keys(ICONS).length} icons → ${path.relative(process.cwd(), ADMIN)}`)
