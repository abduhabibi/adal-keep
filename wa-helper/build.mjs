// node wa-helper/build.mjs : installs the pinned packages (no scripts) and makes out/wa-helper.mjs, one file.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const DIR = import.meta.dirname
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['ci', '--ignore-scripts', '--omit=optional', '--omit=peer', '--no-audit', '--no-fund'], { cwd: DIR, stdio: 'inherit' })
const esbuild = createRequire(path.join(DIR, '..', 'adal-keep-frontend', 'package.json'))('esbuild')
const banner = "import{createRequire as __cr}from'node:module';import{fileURLToPath as __fu}from'node:url';import{dirname as __dn}from'node:path';const require=__cr(import.meta.url),__filename=__fu(import.meta.url),__dirname=__dn(__filename);"
const out = path.join(DIR, 'out', 'wa-helper.mjs')
esbuild.buildSync({ entryPoints: [path.join(DIR, 'helper.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node20', minifyWhitespace: true, minifySyntax: true, legalComments: 'eof', absWorkingDir: DIR,
  external: ['jimp', 'sharp', 'link-preview-js', 'audio-decode'], banner: { js: banner }, outfile: out, logLevel: 'error' })
const b = fs.readFileSync(out)
console.log(out, b.length, 'bytes', crypto.createHash('sha256').update(b).digest('hex'))
