// Background function (up to 15 minutes): the retouch can take a minute, longer than a normal function may.
import { getStore } from '@netlify/blobs'
import { work } from './_lib.mjs'

const keys = () => String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(/[,;\s]+/).filter(Boolean)
export default async (req) => { await work(new URL(req.url).searchParams.get('job') || '', { store: getStore('refine'), keys: keys() }) }
