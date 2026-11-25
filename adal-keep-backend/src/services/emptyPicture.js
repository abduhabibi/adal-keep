/**
 * emptyPicture.js — a picture a robot's tab does not need is answered with an empty one, not failed. A failed picture
 * made Musaned's page ask for its "no-image" picture, which failed too, and so on for ever (2026-11-25, Main: 72 failed
 * requests a second in one idle dashboard tab, 56 % of a core). Off: ADAL_EMPTY_PICTURES=0 (failed, as before).
 */
export const emptyPicturesOn = (env = process.env) => env.ADAL_EMPTY_PICTURES !== '0'
const EMPTY = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** Stops a request of the page: an empty picture for a picture, failed for anything else. Never throws. */
export async function stopRequest(req) {
  try {
    if (!emptyPicturesOn() || req.resourceType() !== 'image') return await req.abort()
    await req.respond({ status: 200, contentType: 'image/gif', headers: { 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' }, body: EMPTY })
  } catch {}
}
