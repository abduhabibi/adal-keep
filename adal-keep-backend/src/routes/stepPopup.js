/**
 * What the "Her CV" pop-up needs beside the girl: the agency's own mobile number (saved
 * once, the same on every PC — a settings row, copied between them) and what is switched on.
 * It is only shown filled in; nothing is written on a girl but by a person's Save.
 * Off: ADAL_STEP_POPUP=0 (all), ADAL_BROKER_SEARCH=0 (the search box only).
 */
import express from 'express'
import { mobileOk, normalizeMobile } from '../services/musanedPreflight.js'

const router = express.Router()
export const MOBILE_KEY = 'agency_mobile'
const off = (res) => res.status(404).json({ error: 'off' })
export const popupOn = () => process.env.ADAL_STEP_POPUP !== '0'

router.get('/settings/step-popup', async (req, res) => {
  if (!popupOn()) return off(res)
  try {
    const row = await req.app.locals.db('settings').where({ key: MOBILE_KEY }).first('value')
    res.json({ mobile: mobileOk(row?.value) ? row.value : '', broker_search: process.env.ADAL_BROKER_SEARCH !== '0' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// The saved number is set, changed or (empty) removed. No girl's number is touched.
router.put('/settings/step-popup/mobile', async (req, res) => {
  if (!popupOn()) return off(res)
  try {
    const raw = String(req.body?.mobile ?? '').trim()
    if (raw && !mobileOk(raw)) return res.status(400).json({ error: 'A mobile number is 9 followed by 8 digits' })
    const db = req.app.locals.db, value = raw ? `0${normalizeMobile(raw)}` : ''
    if (!(await db('settings').where({ key: MOBILE_KEY }).update({ value }))) await db('settings').insert({ key: MOBILE_KEY, value })
    res.json({ mobile: value })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
