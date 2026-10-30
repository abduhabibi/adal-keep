#!/usr/bin/env node
/**
 * Records what Adal Keep says when a task finishes, with an ElevenLabs voice,
 * into src/voice/<line>.wav — the files ship with Adal Keep, so every PC plays
 * the same voice with no key and no internet (services/worker.js).
 *
 *   ELEVENLABS_API_KEY in adal-keep-backend/.env (never committed), then:
 *   node scripts/make-voice.mjs              all lines
 *   node scripts/make-voice.mjs musaned_add  just one
 *   ELEVENLABS_VOICE_ID=…                    another voice (default: Brian, deep)
 * Needs ffmpeg (mp3 → wav, which every PC can play without extra software).
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const HERE = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(HERE, '../.env') })
const KEY = process.env.ELEVENLABS_API_KEY
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'nPczCjzI2devNBz1zQrb'   // Brian — deep, warm, clear
const OUT = path.join(HERE, '../src/voice')

const LINES = {
  musaned_add: 'I have finished filling Musaned.',
  musaned_check: 'I have finished checking Musaned.',
  wafid_book: 'I have finished filling the Wafid medical booking.',
  wafid_check: 'I have finished checking the medical result.',
  wafid_slip: 'I have finished getting the medical appointment slip.',
  police: 'I have finished filling the police certificate.',
  lmis_contract: 'I have finished filling the LMIS contract.',
  insurance: 'I have finished filling the insurance.',
  tasheer: 'I have finished filling Tasheer.',
  visa: 'I have finished filling the visa.',
  done: 'I have finished the task.',
  problem_musaned: 'There is a problem with Musaned. Please have a look.',
  problem_wafid: 'There is a problem with the Wafid medical. Please have a look.',
  problem_police: 'There is a problem with the police certificate. Please have a look.',
  problem_lmis: 'There is a problem with the LMIS contract. Please have a look.',
  problem_insurance: 'There is a problem with the insurance. Please have a look.',
  problem_tasheer: 'There is a problem with Tasheer. Please have a look.',
  problem_visa: 'There is a problem with the visa. Please have a look.',
  problem: 'There is a problem with the task. Please have a look.',
}

if (!KEY) { console.error('No ELEVENLABS_API_KEY in adal-keep-backend/.env'); process.exit(1) }
fs.mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
for (const [name, text] of Object.entries(LINES)) {
  if (only.length && !only.includes(name)) continue
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text, model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
  })
  if (!r.ok) { console.error(`${name}: ElevenLabs said ${r.status} ${(await r.text()).slice(0, 200)}`); process.exitCode = 1; continue }
  const mp3 = path.join(os.tmpdir(), `adal-voice-${name}.mp3`)
  fs.writeFileSync(mp3, Buffer.from(await r.arrayBuffer()))
  // A little silence first (players clip the start), loudness evened out.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-af', 'adelay=150,loudnorm=I=-14:TP=-1.5', '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', path.join(OUT, `${name}.wav`)])
  fs.unlinkSync(mp3)
  console.log(`✓ ${name}: ${text}`)
}
