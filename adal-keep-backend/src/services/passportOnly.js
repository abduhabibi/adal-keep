/**
 * passportOnly.js — a profile is made only from a passport (owner, 2026-11-26).
 *
 *   - Downloads and dropped files (the folder watcher): a passport is recognised on this PC from its machine-readable lines
 *     (valid MRZ, every check digit: quickMrz.js). JEV and Gemini are not asked; anything else is left alone.
 *     ADAL_DOWNLOAD_AI=1 brings the old AI classification of downloads back.
 *   - The contracts check (musanedContracts.js) updates profiles that exist (found by passport number) and never creates one.
 *     ADAL_MUSANED_CREATES=1 brings the old creation back.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { quickMrz } from './quickMrz.js'

export const downloadsUseAI = () => process.env.ADAL_DOWNLOAD_AI === '1'
export const contractsMayCreate = () => process.env.ADAL_MUSANED_CREATES === '1'

const NOT_A_PASSPORT = { doc_type: 'other', confidence: 0, fields: {}, markdown: '', source: 'not-a-passport' }
const LOCAL_LIMIT_MS = Number(process.env.DOWNLOAD_MRZ_LIMIT_MS || 20000)

/**
 * The analyzer of the folder watcher: { doc_type: 'Passport', ... } when the file's bottom lines verify, else 'other'.
 * Images are read directly; a PDF's first page is drawn (off the main thread) and read. No network, no AI. Never throws.
 */
export async function analyzeLocalPassport(filePath) {
  let tmp = null
  try {
    let target = filePath
    if (/\.pdf$/i.test(filePath)) {
      const { pdfFirstPagePng } = await import('./pictures.js')
      const png = await pdfFirstPagePng(filePath)
      tmp = path.join(os.tmpdir(), `adal-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
      fs.writeFileSync(tmp, Buffer.from(png?.buf || png))
      target = tmp
    }
    const r = await quickMrz(target, { deadline: Date.now() + LOCAL_LIMIT_MS, skews: [3, -3, 6, -6] })
    return r ? { ...r, source: 'mrz-local' } : { ...NOT_A_PASSPORT }
  } catch { return { ...NOT_A_PASSPORT } } finally { if (tmp) try { fs.unlinkSync(tmp) } catch {} }
}

/** The profiles the contracts check made with a one-word name (what the owner moves to the Trash). */
export const ONE_WORD_RULE = "created_by = 'Musaned list' AND trim(full_name) <> '' AND trim(full_name) NOT LIKE '% %'"   // (a profile in the Trash is no longer in this table)
export const isOneWordContractProfile = (p) => p?.created_by === 'Musaned list' && !!String(p.full_name || '').trim() && !/\s/.test(String(p.full_name).trim())
