# Photo quality (2026-11-25)

The owner's order: photos never lose quality, megabytes are fine (this replaces the old 300 KB CV rule), her
appearance must not change, and Refine must be a real 2K / 4K choice. Off switch for everything below: `ADAL_PHOTO_QUALITY=0`.

## Research, short
- **300 dpi is a print size, not a JPEG setting**: print size = pixels / dpi, and dpi alone resamples nothing
  ([guide](https://dev.to/pixotter/high-quality-image-printing-dpi-resolution-and-format-guide-f70)). So a picture needs
  frame-inches x 300 pixels, and never more than it really has.
- **JPEG quality 95 with 4:4:4** is the top of the useful range: GIMP's docs say values above 95 are generally not useful and
  4:4:4 keeps borders and contrasting colours ([GIMP JPEG export](https://docs.gimp.org/3.2/en/file-jpeg-export.html)).
  A Google study with human raters tested MozJPEG at q70-95 in 4:2:0 / 4:2:2 / 4:4:4, and found people prefer q95 output
  ([arXiv 2403.18589](https://arxiv.org/html/2403.18589v1)). So: q95, 4:4:4.
- **Real-ESRGAN `realesr-general-x4v3`** has a denoise strength (`-dn`, 0 = keep noise, 1 = strong, default 0.5) and a separate
  face-enhance pass (GFPGAN) ([Real-ESRGAN](https://github.com/xinntao/real-esrgan), [guide](https://mintlify.com/xinntao/Real-ESRGAN/guides/general-images)).
  I could not confirm from these sources how either keeps a person's identity (nothing there measures it), so the faithful default
  uses neither a face model nor a generator.

## What refining can and cannot bring back
- A WhatsApp photo is shrunk to about 1280 px and compressed hard (0.3-1.6 bits per pixel) before we get it. Detail lost there is gone.
- Plain methods (cleaning colour blotches, Lanczos enlargement, a small sharpen) make it **cleaner, smoother and bigger**, not sharper in
  the sense of new detail. On the made-up test portrait they recover almost nothing of the fine detail (detail energy 3.0 vs 11.2 in
  the original, input 4.6), and say so on screen ("adds pixels, not new detail").
- An AI upscaler can invent plausible texture; that is exactly what could change how she looks, so it is not the default.
  If used later: blended with the plain enlargement, no brightness / saturation / gamma change, and the result must still shrink
  back to the input (the measure below).

## The faithful Refine (services/faithfulRefine.js)
Light blur of the colour channels only (YCbCr), Lanczos to the chosen size (original / 2K / 4K, never smaller, never above the choice),
a small unsharp mask, JPEG q95 4:4:4. No generated face, no skin lightening, no brightness/saturation/gamma, nothing leaves the PC.
Before/after side by side (components/RefineCompare.jsx), a person's click, original stays, one at a time.

Measured on a made-up portrait (truth 1440x1920, input = 720x960 JPEG q42; `node scripts/bench-refine.mjs`):

| method | PSNR vs truth | shrunk-back vs input (faithful) | mean colour shift | ms |
|---|---|---|---|---|
| plain Lanczos | 31.06 dB | 37.4 dB | 0.32 | 249 |
| colour soften + Lanczos | 31.17 | 37.8 | 0.42 | 339 |
| **faithful (default)** | 30.75 | 37.5 | 0.41 | 829 |
| faithful, stronger sharpen | 29.44 | 34.7 | 0.42 | 977 |
| old `finish()` (light, colour, gamma, 4K) | 28.86 | 31.7 | **5.52** | 9997 |

Limit used in the tests: mean colour shift under 1.5 (of 255) and shrunk-back PSNR above 33 dB. The old Refine fails the first
(it brightens and tints); the cloud text asked for "slightly lighter" skin and beautifying and is rewritten (refineCore.js, same
file in adal-refine/). Cloud retouch (Gemini) is off by default; the old `/files/:id/refine` route still exists for it.

Times on 2 cores at 50% CPU (A4-5300 will be slower): same size 1.3 s, 2K 1.7 s, 4K 6.4 s for a 960x1280 input.

## CV pictures (services/photoQuality.js, three hooks in cvRender.js)
Old: levels 0.8 / q70 down to 0.36 / q46 until the PDF was under 300 KB (head photo 480 px, passport 1040 px at best).
New: one level, scale 2 (head 1200, body 2000, passport 2600, banners 3200 px = 300 dpi of the largest frame), q95, 4:4:4, no
enlargement; a stored JPEG that already fits goes in unchanged (no decode, no loss); never a smaller level because of size.
Made-up CV (`node scripts/bench-cv-quality.mjs`): PDF 68 KB -> 1665 KB; making its pictures 267 ms -> 2360 ms, PDF 1.9 s -> 3.2 s
on a fast PC (expect 3-4x on the A4-5300).

What depended on the 300 KB rule:
- `cvRender.js` `CV_MAX_BYTES` / `renderSmall` (now skipped), `routes/cv.js` 248 and 430 (they call `htmlToSmallPdf`; no change needed).
- WhatsApp / Telegram sending of the CV: a 1.7 MB PDF is fine on WhatsApp (limit 100 MB for documents) but slower on a poor line.
- The online copy / phone: `cloudSync` copies what is in the DB; CV PDFs are generated, not synced - not checked further here.
- `frontend/src/lib/cvLocal.js` (the phone's own CV): canvas JPEG 0.85 -> 0.95.

## Crops
`FullBodyCropper.jsx` made a fixed 600x1800 (or the caller's outW/outH) at q0.9: now the crop's own pixels (up to 4096 wide, no
enlarging), q0.95. `PickFile.jsx` camera q0.92 -> 0.95. Backend crops (`composite.js`, `labourId.js`, `docPipeline.js`) 92/93 -> 95 4:4:4.
Not checked: that the placement flow keeps the original file in every case.

## Uploads to the sites (not changed: robot code)
| site | limit in our code | where it comes from | now |
|---|---|---|---|
| Enjaz (mofaVisa.js photoJpeg) | 480x600, 100 KB, q88 down to 45 | written in our code, no source quoted; not verified against the site | unchanged |
| LMIS (lmisWorkflow.js) | 2 MB, passport as PDF | the LMIS form (PASSPORT_MAX_MB / PHOTO_MAX_MB) | ladders start at q85 / 2000 px |
| Musaned | 5 MB photo | our code comment | stored file used if it fits |
Proposed, not done because robots must not be touched without a go: LMIS ladders `[2600 q92, 2000 q92, 2000 q85, 1600 ...]`.
Nothing is raised above a limit.

## The AI upscaler's model file (the owner decides; nothing was downloaded)
`realesr-general-x4v3.onnx`, source in refineCore.js (`SR_MODEL_URL`, huggingface CoderViking/realesr-general-x4v3-onnx),
4,866,417 bytes, BSD-3-Clause per the code comment, sha256 not recorded (the file is not on this PC). `onnxruntime-node` is also
not installed in the backend's node_modules. The existing `ensureSrModel` would download it if `ADAL_LOCAL_ENHANCE=1`: leave that off.

## The AI way (added 2026-11-25; off by default: `ADAL_REFINE_ESRGAN=1`)
Real-ESRGAN `realesr-general-x4v3` blended into the plain way: X = (1-a) plain + a AI, a = 30 % -> 20 % -> 10 %, no brightness /
gamma / saturation / normalise on the AI picture. Guards, measured on the result shrunk back to the input's size: PSNR >= **34 dB**
(plain way 37.5, old Refine 31.7 which visibly changed her) and mean colour shift <= **1.0** (plain 0.4, old 5.5); over a limit the
blend is lowered, then the plain way is used and the note says why. Only inputs up to 1400 px long go to the network.
It runs in its own low-priority process (`esrganWorker.mjs`), killed after 3 minutes; one refine at a time; a person's click.
The model loads only from `data/models/realesr-general-x4v3.onnx` with exactly 4,866,417 bytes and sha256
`1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112`; **nothing downloads it** (the old `ensureSrModel` download is gone).
Stub only so far: the network's own picture (tests use a stand-in that enlarges the input with a chosen fault). Real numbers:
`node scripts/esrgan-check.mjs outDir` on a PC with the model and `npm install` done (onnxruntime-node is in package.json).
The 34 dB / 1.0 limits are my choice from the plain-way and old-Refine numbers above, not measured on the real network yet: adjust after
the first real run.

## Is the original kept? (audit, 2026-11-25)
- Refine: yes (a new file; the original stays). Crop review / placement: cut-outs are new files; the combined Passport picture's
  database row is deleted but its file stays on disk and is noted in `data/placement-moves.json` (placement.js ~123): kept on disk, not
  shown on the profile.
- **Found and fixed**: the single-file upload and "assign tray file" (routes/files.js) destroyed the picture a field held when a new
  one replaced it. They now move it to `data/SafeStorage/replaced/` (services/keepOriginals.js).
- Not changed: the webp -> png twin in docPipeline.js (the webp is decoded exactly, nothing is lost); the tray's duplicate copy
  removal after filing (a copy of a file that was just filed).
