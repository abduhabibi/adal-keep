# Adal Refine (Netlify)

Photo ✨ Refine in Adal's cloud, because the agency PCs are weak and Adal has no server. Only refine goes here;
CVs and documents stay on the PC. The PC uploads a 2048 px copy with its Supabase sign-in; the cloud retouches
it (Gemini, same words as the PC: `refineCore.js`), finishes it to 4K (sharp) and keeps the result for one fetch.
Without a working Gemini key (or on Google's free plan, which edits no pictures) it still cleans: levels, colour,
4K, sharpening (`model: clean-only`). The original is deleted from the cloud as soon as the work ends.

## Set up (once, about 10 minutes)
1. Sign up / sign in at https://app.netlify.com (free plan is enough to start; Gemini picture editing needs a
   **Google AI Studio key with billing** — without billing you get `clean-only`).
2. Install the CLI and sign in: `npm i -g netlify-cli` then `netlify login`
   (or make a token: User settings → Applications → Personal access tokens, and `export NETLIFY_AUTH_TOKEN=...`).
3. In this folder: `cd adal-refine && npm install`, then `netlify sites:create --name adal-refine` (pick any free name)
   and `netlify link`.
4. Environment variables (Site configuration → Environment variables, or `netlify env:set NAME value`):
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` — the same two as in the PCs' `.env` (used to check who is signed in)
   - `GEMINI_API_KEYS` — Google AI Studio key(s) with billing, comma separated
   - optional `REFINE_DAILY_CAP` (default 150 pictures per agency per day)
5. Deploy: `netlify deploy --build --prod` (from this folder). Check: `https://<site>.netlify.app/.netlify/functions/refine-status`
   answers `{"error":"Not signed in"}`.
6. On each PC (or Adal Admin's setting for them): `ADAL_CLOUD_REFINE=1` and `ADAL_REFINE_URL=https://<site>.netlify.app`
   in the backend `.env`, restart. Refine tries the cloud first and falls back to the PC itself on any failure.

## Limits
Functions: the upload is a normal function (6 MB body, we send ~1 MB); the retouch runs as a **background function**
(up to 15 minutes), so Gemini's 30-90 s is fine. Results live in Netlify Blobs for one fetch.

## Keeping the picture code the same
`netlify/functions/_refineCore.mjs` is a copy of `adal-keep-backend/src/services/refineCore.js`
(`npm run sync-core`); a test fails if they differ.
