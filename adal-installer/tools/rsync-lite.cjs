#!/usr/bin/env node
/**
 * The few rsync uses of build-installer.sh, for a Windows PC without rsync:
 *   rsync -a [--delete] [--exclude PATTERN]... SRC/ DEST/
 * SRC ending in "/" copies its contents into DEST (as rsync). Patterns match a
 * file or folder name ("node_modules", "*.sqlite*", ".env*").
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const excludes = []
let del = false
const rest = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--exclude') excludes.push(args[++i])
  else if (a.startsWith('--exclude=')) excludes.push(a.slice(10))
  else if (a === '--delete') del = true
  else if (a.startsWith('-')) continue
  else rest.push(a)
}
const [src, dest] = rest
if (!src || !dest) { console.error('rsync-lite: SRC and DEST are needed'); process.exit(2) }
const re = excludes.map(p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'))
const skip = (name) => re.some(r => r.test(name))

const into = src.endsWith('/') ? dest : path.join(dest, path.basename(src))
function copy(from, to) {
  const st = fs.statSync(from)
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true })
    const names = fs.readdirSync(from).filter(n => !skip(n))
    for (const n of names) copy(path.join(from, n), path.join(to, n))
    if (del) for (const n of fs.readdirSync(to)) if (!names.includes(n) && !skip(n)) fs.rmSync(path.join(to, n), { recursive: true, force: true })
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
}
copy(src.replace(/\/$/, '') || src, into)
