#!/usr/bin/env node
/**
 * The published release as ONE file to copy to a PC whose internet is down
 * (2026-11-19): every piece of Adal's signed release from Supabase, checked,
 * in a .zip with the scripts that install it.
 *
 *   node adal-keep-backend/scripts/release-bundle.mjs ["Adal Keep USB/adal-release.zip"]
 *
 * In the zip:  current.json (manifest + Adal's signature), files/<sha256> (the
 * app, every program, the Companion's pages), apply-release.ps1, apply-release.mjs.
 * On the PC (over SSH):
 *   powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force $env:USERPROFILE\adal-release.zip $env:USERPROFILE\adal-release; & $env:USERPROFILE\adal-release\apply-release.ps1"
 * Reads only (the service key from adal-admin/.env); signs nothing.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { verifyManifest, BUCKET } from '../src/services/updateChannel.js'
import { piecesOf } from '../src/services/lanRelease.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const admin = dotenv.parse(fs.readFileSync(path.join(ROOT, 'adal-admin/.env')))
const URL = admin.SUPABASE_URL, KEY = admin.SUPABASE_SERVICE_KEY
if (!URL || !KEY) throw new Error('adal-admin/.env needs SUPABASE_URL and SUPABASE_SERVICE_KEY')
const out = path.resolve(process.argv[2] || path.join(ROOT, 'Adal Keep USB', 'adal-release.zip'))

const get = async (p) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${URL}/storage/v1/object/${BUCKET}/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (!r.ok) throw new Error(`${p}: Supabase answered ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))) }
  }
}

const env = JSON.parse(String(await get('release/latest.json')))
if (!verifyManifest(env.manifest, env.signature)) throw new Error('latest.json is not signed by Adal')
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bundle-'))
try {
  fs.mkdirSync(path.join(stage, 'files'))
  fs.writeFileSync(path.join(stage, 'current.json'), JSON.stringify({ manifest: env.manifest, signature: env.signature }))
  for (const p of piecesOf(env.manifest)) {
    const b = await get(p.file)
    if (crypto.createHash('sha256').update(b).digest('hex') !== p.sha256) throw new Error(`${p.file} does not match the signed release`)
    fs.writeFileSync(path.join(stage, 'files', p.sha256), b)
    console.log(`  ${path.basename(p.file)}  ${(b.length / 1048576).toFixed(1)} MB  ✓`)
  }
  for (const f of ['apply-release.ps1', 'apply-release.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(stage, f))
  fs.writeFileSync(path.join(stage, 'README.txt'), [
    `Adal Keep release ${env.manifest.short} (${env.manifest.published_at}), signed by Adal.`,
    '',
    'Copy this zip to the PC (e.g. scp adal-release.zip hp@<pc>:adal-release.zip), then on that PC:',
    '  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force $env:USERPROFILE\\adal-release.zip $env:USERPROFILE\\adal-release; & $env:USERPROFILE\\adal-release\\apply-release.ps1"',
    '',
    'Nothing is installed unless the signature and every piece\'s SHA-256 match. Only a newer release than the PC\'s is installed.',
    '',
  ].join('\r\n'))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.rmSync(out, { force: true })
  execFileSync('zip', ['-qr', out, '.'], { cwd: stage })
  const sum = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')
  console.log(`✓ ${out}\n  release ${env.manifest.sha}\n  sha256 ${sum}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
