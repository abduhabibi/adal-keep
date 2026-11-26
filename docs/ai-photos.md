# The AI never puts a picture into Photo / Full Body Photo (2026-11-26)

Owner: "there is no way we can classify between people" — only a person puts pictures there. Switch: `ADAL_AI_PHOTOS`
(`1` = every path below back, or a list such as `move,sweep`). Code: `services/aiPhotoGuard.js`; test: `tests/aiPhotoGuard.test.js`.

## Turned OFF by default (each can come back by name)
| name | what it did | where |
|---|---|---|
| `move` | JEV moved a head / standing photo out of Passport into Photo / Full Body (995151a); also `undoWrongMoves` (moved `..._photo.jpg` back into Photo) | placement.js `checkPlacement`, `undoWrongMoves` |
| `split` | one picture cut into passport + Photo + Full Body (6f886c2, 88642f5): the crop-check offers only the passport now; `applyParts` / `fileInto` drop the photo parts | placement.js, composite.js callers, docPipeline.js (composite split) |
| `sweep` | the 7-day look-back after each start | placement.js `sweepRecent` (main.js hook unchanged) |
| `face` | her face cut from the passport saved as her Photo (`Passport_..._photo.jpg`) | musanedImport.js (Musaned's own personal photo is kept) |
| `classify` | a file the AI classifies as "Photo" / "Full Body Photo" and matches to a profile (by name / JEV person) was filed into that profile | docPipeline.js `runPipeline` (the tray, folder watch, ingest) |
Also: a picture a person put into Photo / Full Body is no longer even looked at by JEV (nothing can happen to it).
Still working: the passport read and cut out as the passport; a picture a person put in stays where they put it; a person ticking a
cut-out in an old waiting crop check still puts it there (their own click).

## Still ON — copies of a record of the SAME passport (not face guessing); leave until the owner says
1. **Musaned list / contracts** (`musanedContracts.js` ~1106, "Photo saved"): the PERSONAL photo of her request on Musaned.
2. **Musaned import / copy** (`musanedImport.js` personal photo; `musanedCopy.js` 325): Musaned's own personal photo.
3. **Transitions** (`transition.js`, `enjazPlusCopy.js`, `easyEnjazCopy.js`): another agency system's photo / standing photo of the
   same person, found by passport number; note `transition.js` ~219 chooses Photo for a file by its NAME (passport-size / headshot / profile photo).
4. **A CV PDF from another agency** (`docPipeline.js` `pdfPictures`, kind `pdf`): the pictures inside the PDF of that CV, the profile
   found by the passport number in it; the photo is picked by SHAPE (the near-square picture is the photo, the tall one the full body)
   — a shape guess within her own document, not a face match. Name: `pdf` (to turn it off too: not in the off list; ask).
