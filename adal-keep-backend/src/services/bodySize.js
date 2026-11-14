/**
 * Height and weight when nobody wrote them: instead of "Normal", a believable
 * number with one decimal — height 155.0–165.0 (cm), weight 55.0–65.0 (kg),
 * e.g. 158.4 and 60.7. Each girl always gets the same two numbers (they come
 * from her passport number), so her CV says the same thing every time.
 * What a person typed is never changed.
 */
import crypto from 'crypto'

/** Empty, or one of the old placeholders. */
export const unset = (v) => !String(v ?? '').trim() || /^(normal|-+|n\/?a|none)$/i.test(String(v).trim())

const keyOf = (p) => String(p?.passport_number || p?.id || p?.full_name || '').trim().toUpperCase()

// 0.1 … 9.9, never a round .0 (a measured look), the same for the same girl.
function spread(key, salt) {
  const h = crypto.createHash('sha256').update(`${salt}:${key}`).digest()
  return h.readUInt32BE(0) % 10 + (1 + h.readUInt32BE(4) % 9) / 10
}

export const heightFor = (p) => (155 + spread(keyOf(p), 'height')).toFixed(1)
export const weightFor = (p) => (55 + spread(keyOf(p), 'weight')).toFixed(1)

/** Her height and weight as shown: what is written, else her numbers. */
export function withBodySize(p) {
  return { ...p, height: unset(p.height) ? heightFor(p) : p.height, weight: unset(p.weight) ? weightFor(p) : p.weight }
}

/** Every profile without a height or weight gets hers (only those fields, only when empty). */
export async function fillBodySizes(db) {
  const rows = await db('profiles')
    .where(q => q.whereNull('height').orWhere('height', '').orWhereRaw("LOWER(TRIM(height)) IN ('normal','-','--','n/a','na','none')")
      .orWhereNull('weight').orWhere('weight', '').orWhereRaw("LOWER(TRIM(weight)) IN ('normal','-','--','n/a','na','none')"))
    .select('id', 'passport_number', 'full_name', 'height', 'weight')
  for (const p of rows) {
    const upd = {}
    if (unset(p.height)) upd.height = heightFor(p)
    if (unset(p.weight)) upd.weight = weightFor(p)
    if (Object.keys(upd).length) await db('profiles').where('id', p.id).update(upd)
  }
  return rows.length
}

/** New profiles from anywhere (the form, a move, a passport read): filled as they come. */
export function keepBodySizesFilled(db, onChanged) {
  let timer = null
  onChanged(({ tables }) => {
    if (!tables.includes('profiles') && !tables.includes('*')) return
    clearTimeout(timer)
    timer = setTimeout(() => fillBodySizes(db).catch(e => console.warn('[body size]', e.message)), 1500)
  })
}
