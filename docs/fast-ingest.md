# Faster profile making (2026-11-27) — `ADAL_FAST_INGEST=0` brings the old behaviour back

## What Main's server.log showed (130k lines, no timestamps but every Gemini answer has its time)
- Gemini reading a document: median 13 s (gemini-3.6-flash 13 s mean 17 s, p90 35 s), the Flash-Lite fallbacks p90 ~2 min.
- 185 calls ran the full 45 s to "no answer", 225 JEV calls timed out at 8 s, 148 JEV "fetch failed" (no line): about 2.3 hours of waiting in the log.
- Cause 1: the whole scan went up as base64 (MBs) over Main's 4-5 Mbit/s Wi-Fi: a 7 MB scan is ~16 s of upload before Gemini even starts.
- Cause 2: a slow or dead line was tried on every model (4), three attempts each, 2-6 s sleeps between: up to 3 minutes per document.
- Also seen, not changed here: 29 CV PDFs "the other PC could not draw it — drawn here: timeout" (the helper PC's draw timed out, then it is drawn here); 74 MinerU "fetch failed".

## Changed (`services/geminiClassifier.js`, all behind `ADAL_FAST_INGEST`)
| what | before | after |
|---|---|---|
| picture sent to Gemini | the file as is | a copy shrunk to 1800 px long side, JPEG 82 (only images over 350 KB / 1800 px). The stored file is never read-write touched: no photo, scan or document on disk changes |
| a model that gave no answer in 45 s | next ask tries it again, 45 s again | rests 90 s; the next asks skip it; every model resting: the ask fails at once and the usual path (local OCR / MinerU) goes on |
| no internet (fetch failed, DNS, reset) | every model x 3 attempts with sleeps (~24 s+) | one failure; every ask fails at once for 60 s, then tries again |

Measured with a local mock Gemini (`tests/fastIngest.test.js`, a 2480x3508 scan, 6.9 MB, the worst case for compression):
sent 9.27 MB -> 0.93 MB, i.e. 16.5 s -> 1.7 s of upload on a 4.5 Mbit/s Wi-Fi; a model with no answer: second ask 603 ms -> 5 ms (45 s -> 0 in real life);
no line: second ask ~24 s -> 8 ms.

## Not done here (needs its own task, each can be measured after this)
Showing the profile at once after the MRZ read with CV and the rest in the background; running independent stages in parallel; not
re-doing unchanged stages. The log has no per-stage lines for those yet; `[first-stage]` shows only the end results.
