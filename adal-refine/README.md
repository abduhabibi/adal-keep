# Adal Refine (Netlify)

Photo ✨ Refine in Adal's cloud, because the agency PCs are weak and Adal has no server. Only refine goes here;
CVs and documents stay on the PC. The PC uploads a 2048 px copy with its Supabase sign-in; the cloud does the
work and keeps the result for one fetch; the original is deleted as soon as the work ends.

**The work (free, no quota, no token):** silueta (U²-Net, Apache-2.0, 43 MB) runs in ONNX inside the function,
finds the girl, puts her on a plain white background, crops to a CV framing (Photo: head and shoulders 3:4;
Full Body Photo: all of her 2:3), fixes light and colour gently, sharpens, 4K (`services/refineCore.js`).
If nobody is found clearly it only cleans (`model: clean-only`), never cuts wrongly.
`REFINE_ENGINE=gemini` switches to the Gemini retouch (needs a Google key with billing).

## Set up (once, about 10 minutes)
1. Sign up / sign in at https://app.netlify.com (the free plan is enough to start).
2. CLI: `npm i -g netlify-cli`, then `netlify login`
   (or a token: User settings → Applications → Personal access tokens → `export NETLIFY_AUTH_TOKEN=...`).
3. In this folder: `cd adal-refine && npm install`, `netlify sites:create --name adal-refine` (any free name), `netlify link`.
4. Environment variables (`netlify env:set NAME value`, or Site configuration → Environment variables):
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` — the same two as in the PCs' `.env` (checks who is signed in)
   - optional `REFINE_DAILY_CAP` (default 150 pictures per agency per day); `GEMINI_API_KEYS` only with `REFINE_ENGINE=gemini`
5. Deploy: `netlify deploy --build --prod` (the build downloads the model once: `node fetch-model.mjs`).
   Check: `https://<site>.netlify.app/.netlify/functions/refine-status` answers `{"error":"Not signed in"}`.
6. On each PC, in the backend `.env`: `ADAL_CLOUD_REFINE=1` and `ADAL_REFINE_URL=https://<site>.netlify.app`; restart.
   Optional, for when the internet is down: `ADAL_LOCAL_CUTOUT=1` (the PC fetches the same model once into
   `data/models/` and runs it with `onnxruntime-node`, an optional dependency).
   Refine tries the cloud first and falls back to the PC on any failure.

## Limits
Upload = a normal function (6 MB body; we send ~1 MB). The work is a **background function** (up to 15 minutes).
Size: the function ships the model (43 MB) + onnxruntime for linux/x64 (46 MB) + sharp, well under the 250 MB limit.
Results live in Netlify Blobs for one fetch.

## Keeping the picture code the same
`netlify/functions/_refineCore.mjs` is a copy of `adal-keep-backend/src/services/refineCore.js`
(`npm run sync-core`); a test fails if they differ.
