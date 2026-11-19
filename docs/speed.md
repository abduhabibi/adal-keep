# Speed: before and after (branch `speed`, 2026-11-19)

Measured on the Linux dev PC (4 cores), on a scratch database. No `.env`, no keys,
no Supabase, no Telegram. Scripts are in `adal-keep-backend/scripts/`:
`bench-passport.mjs`, `bench-speed.mjs` (route level, `/api/new-profile/*`),
`bench-cv.mjs` (CV service level). `make-sample-passport.mjs` makes the sample:
the ICAO specimen page (ERIKSSON ANNA MARIA) "photographed" at 4218x3139 and
slightly tilted, in `tests/fixtures/sample-passport.jpg`. It is not a real person.

The Gemini place-of-birth call is **simulated** at 5000 ms, a typical image call
on an office line. The cap in the code is 8000 ms. Network round trips (RTT) for
the Companion depend on the line, so they are given as counts, not ms.

| # | Action | Before (ms) | After (ms) | What changed |
|---|---|---|---|---|
| 1 | Passport → form filled (Main PC, `POST /new-profile/read`, MRZ verified) | 5460 (MRZ + place in line; up to ~8800 at the Gemini cap) | **430** warm / 734 first | The answer returns as soon as the check digits verify. Place of birth, region and issue date follow via `GET /new-profile/place/:upload` and fill only empty fields. |
| 2 | Place of birth / region / issue date | inside #1 | +5067 behind the form (nobody waits) | Background `placeLater` promise, kept 2 min |
| 3 | MRZ local read, first passport of the day | 816 | 633 | Reader warmed when the page opens (`POST /new-profile/warm`), kept 10 min (was 2) |
| 4 | MRZ local read, warm | 509 | 435 | Strip cut in the decode pass, PNG buffer to OCR (no turned full-page copy, no temp file) |
| 5 | MRZ, page upside down | 1442 | 1147 | The next crop is cut while the current one is read |
| 6 | MRZ, page sideways (5th crop) | 2702 | 1857 | same |
| 7 | Passport on a Companion (online pages, 127.0.0.1:47801) | full image uploaded online → relayed to Main PC → read → polled back (≥ 2 RTT + upload of 3-5 MB) | ≈ 450-650, read in the Companion's own window; nothing uploaded to read it | `readPassportHere` (tesseract wasm, OCR-B, check digits) now runs on the Companion, as on phones. It falls back to the PC if the MRZ does not verify. |
| 8 | CV preview, first open (pictures shrunk) | 1258 | 1146 (pictures in parallel) → **~0 on click**, drawn 0.7 s after the last form change | Debounced pre-render. Previews cached per body, so reopening or switching template back is instant. `POST /cv/warm` shrinks the photos when the page opens. |
| 9 | CV preview again (same CV) | 1 server + 1 RTT | 0 (client cache) | `previews` map in CVNewPage |
| 10 | Full-body framing (personBox) | in the page, every load | once on the PC, cached by picture (`data-adal-box`) | Same algorithm (`adalBoxOf`), shared by the PC and the page |
| 11 | Download PDF / Save as, first PDF (browser cold) | 753 + browser start | **1** (copy) | Browser starts on `/cv/warm`. The PDF is made behind the open preview (`POST /cv/prepare`), and Download copies it, keyed by the sha1 of the exact page. |
| 12 | Download PDF, browser warm, not prepared | 138 | 112 | — |
| 13 | Reopen a profile (Main PC or Companion) | spinner until `/profiles/:id` + `/fields` answer (1 RTT + server) | 0 network waits: memory or IndexedDB copy at once, fresh copy behind | `lib/profileCache.js` (stale-while-revalidate) |
| 14 | Open a profile pointed at in the list / search pad | 1 RTT | 0 (fetched on hover/touch; last 6 opened fetched when the list opens) | `prefetchProfile`, `prefetchRecent` |
| 15 | Profile pictures on reopen | 1 RTT each (revalidated, `max-age=0`) | 0 (`Cache-Control: private, max-age=3600`; warmed by prefetch) | `/files/:id/thumbnail` |
| 16 | Profiles list, brokers, other GETs | already device-cached (`api.js` IndexedDB, `profilesCache`) | unchanged | `warm` / `cv/preview` / `cv/prepare` POSTs no longer mark the cache dirty |
| 17 | Static assets | `/assets/*` already `max-age=31536000, immutable` + gzip | unchanged | — |

## Notes

- **Where "23 s" came from.** On the old path the answer always waited for the
  place-of-birth call (up to 8 s). When the first crop did not verify, it also
  waited for the JEV/Gemini race. The place call is now off the critical path,
  and the local crops are faster. JEV/Gemini still race exactly as before when
  the MRZ cannot be read locally.
- A prepared PDF is used only if the page is byte-identical to what Download
  would make: same profile, template, form and edits. Otherwise the PDF is made
  as before. Prepared PDFs live in the OS temp folder for 10 minutes, and nothing
  is saved on her profile until Download or Save as.
- The profile edit form still reads from the PC (never from a kept copy).
- The phone CV copy (`src/lib/cvLocal.js`) has the same page script
  (`tests/cvLocal.test.js`).
