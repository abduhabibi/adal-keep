/** 059 — Profiles whose height or weight is empty or "Normal" get believable numbers (155.0–165.0, 55.0–65.0). */
import { fillBodySizes } from '../services/bodySize.js'

export async function up(knex) {
  try {
    const n = await fillBodySizes(knex)
    if (n) console.log(`[059] height and weight filled for ${n} profile(s)`)
  } catch (e) { console.warn('[059]', e.message) }
}

export async function down() {}
