const V = {}
for (let i = 0; i < 10; i++) V[String(i)] = i
for (let i = 0; i < 26; i++) V[String.fromCharCode(65 + i)] = 10 + i
V['<'] = 0
const W = [7, 3, 1]
function cd(s) {
  let sum = 0
  for (let i = 0; i < s.length; i++) {
    const v = V[s[i]]
    if (v === undefined) return null
    sum += v * W[i % 3]
  }
  return sum % 10
}
function iso(yymmdd, pivot = 50) {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4), dd = +yymmdd.slice(4, 6)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const y = (yy > pivot ? 1900 : 2000) + yy
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

// Fix OCR garbage in the MRZ name field. Rejects tokens that cannot be
// human names, and strips a common "<" -> "K"/"C"/"X" misread at word start.
function cleanMrzName(raw) {
  if (!raw) return ''
  let out = String(raw).replace(/</g, ' ').replace(/\s+/g, ' ').trim().toUpperCase()
  const cleaned = out.split(' ').map(tok => {
    if (!tok) return ''
    // Strip a leading K/C/X if followed by a consonant (likely misread "<")
    if (tok.length >= 4 && /^[KCX]/.test(tok) && !/^[KCX][AEIOU]/.test(tok)) {
      tok = tok.slice(1)
    }
    return tok
  }).filter(tok => {
    if (!tok) return false
    if (tok.length < 2) return false
    if (!/[AEIOU]/.test(tok)) return false          // no vowel -> garbage (CLLLLL)
    if (/(.)\1{2,}/.test(tok)) return false         // 3+ repeated chars -> garbage
    if (tok.length > 22) return false               // absurdly long token
    if (!/^[A-Z'\-]+$/.test(tok)) return false       // only letters, apostrophe, hyphen
    return true
  })
  return cleaned.join(' ').trim()
}


// In an MRZ, '<' is the ONLY padding/separator char. OCR commonly misreads it
// as C, K, X when the print is faint. Restore it before splitting.
function normalizeMrzOcr(line) {
  if (!line || line.length < 5) return line
  const prefix = line.slice(0, 5)      // P<ETH
  let name = line.slice(5)
  // 1. Runs of 2+ identical [CKX] -> '<' of same length
  name = name.replace(/([CKX])\1+/gi, (m) => '<'.repeat(m.length))
  // 2. Single [CKX] adjacent to '<' -> collapse into '<'
  name = name.replace(/<[CKX]/g, '<').replace(/[CKX]</g, '<')
  // 3. Long word (>=12 chars) with a C/K/X between two 3+ letter runs
  //    -> insert separator (heuristic for a lost single '<')
  name = name.replace(/([A-Z]{3,})[CKX]([A-Z]{3,})/g, (full, a, b) => {
    if (full.length >= 12) return a + '<' + b
    return full
  })
  return prefix + name
}

export function parseTD3(mrzText) {
  if (!mrzText) return null
  const lines = mrzText
    .split(/\r?\n/)
    .map(l => l.replace(/\s/g, '').toUpperCase())
    .filter(l => l.length >= 40 && /^[A-Z0-9<]{40,}$/.test(l))
  if (lines.length < 2) return null
  const l1 = normalizeMrzOcr(lines[0]).padEnd(44, '<').slice(0, 44)
  const l2 = lines[1].padEnd(44, '<').slice(0, 44)
  if (l1[0] !== 'P') return null
  const issuing = l1.slice(2, 5).replace(/</g, '')
  const nameField = l1.slice(5, 44)
  const parts = nameField.split('<<')
  const surname = cleanMrzName(parts[0] || '')
  // Everything after the first '<<' is a given name. OCR sometimes inserts
  // an extra '<<' inside the given-names region — keep all non-empty parts.
  const given = cleanMrzName(parts.slice(1).filter(x => x && x.trim()).join(' '))
  const pno = l2.slice(0, 9)
  const pnoCd = l2.slice(9, 10)
  const nat = l2.slice(10, 13).replace(/</g, '')
  const dob = l2.slice(13, 19)
  const dobCd = l2.slice(19, 20)
  const sex = l2.slice(20, 21)
  const exp = l2.slice(21, 27)
  const expCd = l2.slice(27, 28)
  const per = l2.slice(28, 42).replace(/</g, '').trim()
  const ovCd = l2.slice(43, 44)
  const ovComposite = pno + pnoCd + dob + dobCd + exp + expCd + l2.slice(28, 42) + l2.slice(42, 43)
  return {
    doc_type: 'passport',
    passport_number: pno.replace(/</g, '').trim(),
    passport_number_verified: cd(pno) === +pnoCd,
    surname,
    given_names: given,
    nationality_code: nat,
    date_of_birth: iso(dob, 50),
    date_of_birth_verified: cd(dob) === +dobCd,
    sex: sex === 'M' ? 'M' : sex === 'F' ? 'F' : null,
    date_of_expiry: iso(exp, 50),
    date_of_expiry_verified: cd(exp) === +expCd,
    personal_number: per || null,
    issuing_country: issuing,
    overall_verified: cd(ovComposite) === +ovCd,
    mrz_line1: l1,
    mrz_line2: l2,
  }
}
