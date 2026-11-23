// POST /.netlify/functions/refine-start?job=<id>&field=Photo  (body: the picture; Authorization: the agency's Supabase token)
import { getStore } from '@netlify/blobs'
import { start, whoIs } from './_lib.mjs'

export default async (req) => start(req, {
  store: getStore('refine'),
  who: whoIs,
  // The background function takes the job by its id only; the picture waits in the store.
  startBackground: async (job) => {
    const r = await fetch(new URL(`/.netlify/functions/refine-work-background?job=${encodeURIComponent(job)}`, req.url), { method: 'POST' })
    if (r.status >= 400) throw new Error(`worker answered ${r.status}`)
  },
})
