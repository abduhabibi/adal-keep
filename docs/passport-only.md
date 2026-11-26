# Profiles are made only from a passport (2026-11-26)

## Downloads and dropped files
`aiIngestion.processFile` (the folder watcher: Downloads, Telegram Desktop, C:\AdalKeep\inbox) now asks `passportOnly.analyzeLocalPassport`:
the file's machine-readable lines are read on this PC (OCR-B reader, every ICAO check digit must verify; a PDF's first page is drawn off the
main thread; a crooked page is also tried turned 3 and 6 degrees). A valid MRZ makes/finds the profile as before; anything else is
"other" and left alone. JEV, Gemini and the network are never called (also not the JEV picture-cutting step: `runPipeline(..., { noAi: true })`).
`ADAL_DOWNLOAD_AI=1` brings the old AI classification of downloads back. Slips, CVs and other documents that arrive in Downloads are
therefore no longer filed by themselves (only a person files them).

Measured (`scripts/bench-passport-detect.mjs`, made-up files only: 10 passports = the ICAO specimen photographed 10 ways incl. turned 90/180,
blurred, noisy, dull, JPEG q18, tilted 4 degrees, a PDF scan; 8 non-passports = blank, a portrait, a letter, a form table, MRZ-like lines with a
wrong check digit, MRZ-like filler text, a tiny icon, a screenshot): false yes 0 of 8, false no 0 of 10. That set is small and made up:
real photographs will be harder; it says nothing about real agency files.
Time per file: free i5: passports 0.4 s median (up to 4 s for the tilted one), others 1.8 s median (the dense table 13 s); 2 cores at 50 % CPU:
passports 1.0 s median, 9.6 s worst (tilted), others 4 s median; a dense text page hits the 20 s limit (`DOWNLOAD_MRZ_LIMIT_MS`) and is called
"not a passport". Weak Main (A4-5300) will be slower again; one file at a time in the queue.

## The contracts check
`musanedContracts.js`: `scanRows` (the Musaned data way) and `addFromMusaned` (the page way) no longer create a profile for a girl who is
not found by passport number (they are listed as "not added — only a passport makes a profile"); a profile that exists is still updated.
`ADAL_MUSANED_CREATES=1` brings creation back.

Why the names had one word: the profile's name was taken from Musaned's own name fields only (the list's `candidateName`, the hr pool's
`name`, the contract's candidate `name`; `profileFromRequest`), the longest of them. Musaned often holds only a first name there; the
passport's full name (given names + surname) was never read, so a one-word name stayed. A second bug kept it that way: the "her full name now"
upgrade (`scanRows`, `p.created_by === 'Musaned list'`, and the sort in `profileFromRequest`) splits names with `/s+/` (the letter s) instead
of `/\s+/`, so on upper-case names it never counts words and never fires. I did not fix that line (it would start renaming profiles).

## Picking the one-word profiles (exact rule, read-only list: `node scripts/one-name-profiles.mjs`)
`created_by = 'Musaned list'` AND `trim(full_name) NOT LIKE '% %'` (one word). Nothing made by a person ('System', an employee's name,
passport reading) is touched; the Trash removes the row from `profiles`, so a trashed one no longer matches. The script also shows files
count and whether the profile was edited after it was made (a person may have fixed some: check those before trashing).
