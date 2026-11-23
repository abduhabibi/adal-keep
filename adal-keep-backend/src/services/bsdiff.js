/**
 * bsdiff.js — a binary diff for updates (asked on 2026-11-23: a 60 MB update
 * took 20 minutes on an agency's slow Wi-Fi; a typical release should be ~1 MB).
 *
 * Colin Percival's bsdiff (suffix array of the old file, approximate matches,
 * the byte differences stored apart from the new bytes), with gzip in place of
 * bzip2 so Node (zlib) and the Go Companion (compress/gzip, bspatch.go) both
 * apply it with nothing but their standard library.
 *
 *   "ADALDIF1" | newSize i64 | ctrlGz i64 | diffGz i64 | ctrl.gz | diff.gz | extra.gz
 *   ctrl = (add i64, copy i64, seek i64)*   — little-endian, seek may be negative
 *
 * diff() runs only on Adal's PC (publish-update.mjs); patch() runs on every PC
 * and its result is always checked against the signed SHA-256 afterwards.
 */
import zlib from 'zlib'

const MAGIC = Buffer.from('ADALDIF1')

function qsufsort(old) {
  const n = old.length
  const I = new Int32Array(n + 1), V = new Int32Array(n + 1)
  const buckets = new Int32Array(256)
  for (let i = 0; i < n; i++) buckets[old[i]]++
  for (let i = 1; i < 256; i++) buckets[i] += buckets[i - 1]
  for (let i = 255; i > 0; i--) buckets[i] = buckets[i - 1]
  buckets[0] = 0
  for (let i = 0; i < n; i++) I[++buckets[old[i]]] = i
  I[0] = n
  for (let i = 0; i < n; i++) V[i] = buckets[old[i]]
  V[n] = 0
  for (let i = 1; i < 256; i++) if (buckets[i] === buckets[i - 1] + 1) I[buckets[i]] = -1
  I[0] = -1
  for (let h = 1; I[0] !== -(n + 1); h += h) {
    let len = 0, i = 0
    while (i < n + 1) {
      if (I[i] < 0) { len -= I[i]; i -= I[i] } else {
        if (len) I[i - len] = -len
        len = V[I[i]] + 1 - i
        split(I, V, i, len, h)
        i += len; len = 0
      }
    }
    if (len) I[i - len] = -len
  }
  for (let i = 0; i < n + 1; i++) I[V[i]] = i
  return I
}

// Larsson–Sadakane split, with its own stack (no deep recursion), in the original order.
function split(I, V, start0, len0, h) {
  const stack = [[0, start0, len0]]
  while (stack.length) {
    const [kind, start, len] = stack.pop()
    if (kind === 1) { // the equal group: one rank, sorted once alone
      for (let i = 0; i < len; i++) V[I[start + i]] = start + len - 1
      if (len === 1) I[start] = -1
      continue
    }
    if (len < 16) {
      let j
      for (let k = start; k < start + len; k += j) {
        j = 1
        let x = V[I[k] + h]
        for (let i = 1; k + i < start + len; i++) {
          const v = V[I[k + i] + h]
          if (v < x) { x = v; j = 0 }
          if (v === x) { const t = I[k + j]; I[k + j] = I[k + i]; I[k + i] = t; j++ }
        }
        for (let i = 0; i < j; i++) V[I[k + i]] = k + j - 1
        if (j === 1) I[k] = -1
      }
      continue
    }
    const x = V[I[start + (len >> 1)] + h]
    let jj = 0, kk = 0
    for (let i = start; i < start + len; i++) { const v = V[I[i] + h]; if (v < x) jj++; if (v === x) kk++ }
    jj += start; kk += jj
    let i = start, j = 0, k = 0
    while (i < jj) {
      const v = V[I[i] + h]
      if (v < x) i++
      else if (v === x) { const t = I[i]; I[i] = I[jj + j]; I[jj + j] = t; j++ }
      else { const t = I[i]; I[i] = I[kk + k]; I[kk + k] = t; k++ }
    }
    while (jj + j < kk) {
      if (V[I[jj + j] + h] === x) j++
      else { const t = I[jj + j]; I[jj + j] = I[kk + k]; I[kk + k] = t; k++ }
    }
    // Pushed last-first: the lower part, then the equal group, then the upper part.
    if (start + len > kk) stack.push([0, kk, start + len - kk])
    stack.push([1, jj, kk - jj])
    if (jj > start) stack.push([0, start, jj - start])
  }
}

function matchlen(a, ai, b, bi) {
  let i = 0
  const n = Math.min(a.length - ai, b.length - bi)
  while (i < n && a[ai + i] === b[bi + i]) i++
  return i
}

function cmp(a, ai, b, bi) {
  const n = Math.min(a.length - ai, b.length - bi)
  for (let i = 0; i < n; i++) { const d = a[ai + i] - b[bi + i]; if (d) return d }
  return 0
}

function search(I, old, nw, ni, st, en) {
  for (;;) {
    if (en - st < 2) {
      const x = matchlen(old, I[st], nw, ni), y = matchlen(old, I[en], nw, ni)
      return x > y ? [x, I[st]] : [y, I[en]]
    }
    const m = st + ((en - st) >> 1)
    if (cmp(old, I[m], nw, ni) < 0) st = m; else en = m
  }
}

const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }

/** The patch that turns `old` into `nw` (both Buffers). */
export function diff(old, nw) {
  const I = qsufsort(old)
  const oldsize = old.length, newsize = nw.length
  const db = Buffer.alloc(newsize + 1), eb = Buffer.alloc(newsize + 1)
  const ctrl = []
  let dblen = 0, eblen = 0
  let scan = 0, len = 0, pos = 0, lastscan = 0, lastpos = 0, lastoffset = 0
  while (scan < newsize) {
    let oldscore = 0
    let scsc = scan += len
    for (; scan < newsize; scan++) {
      [len, pos] = search(I, old, nw, scan, 0, oldsize)
      for (; scsc < scan + len; scsc++) if (scsc + lastoffset < oldsize && old[scsc + lastoffset] === nw[scsc]) oldscore++
      if ((len === oldscore && len !== 0) || len > oldscore + 8) break
      if (scan + lastoffset < oldsize && old[scan + lastoffset] === nw[scan]) oldscore--
    }
    if (len !== oldscore || scan === newsize) {
      let s = 0, Sf = 0, lenf = 0
      for (let i = 0; lastscan + i < scan && lastpos + i < oldsize;) {
        if (old[lastpos + i] === nw[lastscan + i]) s++
        i++
        if (s * 2 - i > Sf * 2 - lenf) { Sf = s; lenf = i }
      }
      let lenb = 0
      if (scan < newsize) {
        let s2 = 0, Sb = 0
        for (let i = 1; scan >= lastscan + i && pos >= i; i++) {
          if (old[pos - i] === nw[scan - i]) s2++
          if (s2 * 2 - i > Sb * 2 - lenb) { Sb = s2; lenb = i }
        }
      }
      if (lastscan + lenf > scan - lenb) {
        const overlap = lastscan + lenf - (scan - lenb)
        let s3 = 0, Ss = 0, lens = 0
        for (let i = 0; i < overlap; i++) {
          if (nw[lastscan + lenf - overlap + i] === old[lastpos + lenf - overlap + i]) s3++
          if (nw[scan - lenb + i] === old[pos - lenb + i]) s3--
          if (s3 > Ss) { Ss = s3; lens = i + 1 }
        }
        lenf += lens - overlap
        lenb -= lens
      }
      for (let i = 0; i < lenf; i++) db[dblen + i] = (nw[lastscan + i] - old[lastpos + i]) & 255
      const extra = scan - lenb - (lastscan + lenf)
      for (let i = 0; i < extra; i++) eb[eblen + i] = nw[lastscan + lenf + i]
      dblen += lenf; eblen += extra
      ctrl.push(i64(lenf), i64(extra), i64(pos - lenb - (lastpos + lenf)))
      lastscan = scan - lenb; lastpos = pos - lenb; lastoffset = pos - scan
    }
  }
  const gz = (b) => zlib.gzipSync(b, { level: 9 })
  const c = gz(Buffer.concat(ctrl)), d = gz(db.subarray(0, dblen)), e = gz(eb.subarray(0, eblen))
  return Buffer.concat([MAGIC, i64(newsize), i64(c.length), i64(d.length), c, d, e])
}

/** `old` + a patch from diff() → the new file (thrown on a damaged patch). */
export function patch(old, p) {
  if (p.length < 32 || !p.subarray(0, 8).equals(MAGIC)) throw new Error('not an Adal patch')
  const newsize = Number(p.readBigInt64LE(8)), cl = Number(p.readBigInt64LE(16)), dl = Number(p.readBigInt64LE(24))
  if (newsize < 0 || cl < 0 || dl < 0 || 32 + cl + dl > p.length || newsize > 2 ** 31) throw new Error('damaged patch')
  const ctrl = zlib.gunzipSync(p.subarray(32, 32 + cl))
  const db = zlib.gunzipSync(p.subarray(32 + cl, 32 + cl + dl))
  const eb = zlib.gunzipSync(p.subarray(32 + cl + dl))
  const out = Buffer.alloc(newsize)
  let oldpos = 0, newpos = 0, dp = 0, ep = 0
  for (let c = 0; newpos < newsize; c += 24) {
    if (c + 24 > ctrl.length) throw new Error('damaged patch')
    const x = Number(ctrl.readBigInt64LE(c)), y = Number(ctrl.readBigInt64LE(c + 8)), z = Number(ctrl.readBigInt64LE(c + 16))
    if (x < 0 || y < 0 || newpos + x > newsize || dp + x > db.length) throw new Error('damaged patch')
    for (let i = 0; i < x; i++) {
      const o = oldpos + i
      out[newpos + i] = (db[dp + i] + (o >= 0 && o < old.length ? old[o] : 0)) & 255
    }
    newpos += x; oldpos += x; dp += x
    if (newpos + y > newsize || ep + y > eb.length) throw new Error('damaged patch')
    eb.copy(out, newpos, ep, ep + y)
    newpos += y; ep += y
    oldpos += z
  }
  return out
}
