// GET /.netlify/functions/refine-status?job=<id>  → 202 working | 200 the picture | 502 {error}
import { getStore } from '@netlify/blobs'
import { status, whoIs } from './_lib.mjs'
export default async (req) => status(req, { store: getStore('refine'), who: whoIs })
