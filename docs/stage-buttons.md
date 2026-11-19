# Buttons per stage

One rule for every view: `adal-keep-frontend/src/lib/stageActions.js` (`shows(key, phase, after)`).
The profile page, its AI Actions, the Profiles list (Waiting tab's Check now, the
selection bar), the phone and the Companion (same frontend) all ask it. Change a
row there and it changes everywhere. Test: `adal-keep-backend/tests/stageActions.test.js`.

Stages are the Profiles page's tabs (`lib/phase.js`): CV → Musaned → Waiting →
Selected → Wafid → EPRO → Tasheer → Insurance → Visa → Police → Ready, plus Unfit.

Rule: a button shows on its own stage, plus the next stage where a redo is common.
After the EPRO, "next" follows the agency's dragged order (Settings `journey_order`),
so with Visa before Tasheer, EPRO approve shows on EPRO + Visa. Universal actions
show everywhere. A run that is working, waiting or in line always shows, whatever
the stage. An unknown stage hides nothing.

The table below uses the default order (Tasheer → Insurance → Visa → Police).

| Button | Where | CV | Mus | Wait | Sel | Wafid | EPRO | Tash | Ins | Visa | Police | Ready | Unfit |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| ← Back | Profile header | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| ✏️ Edit | Profile header and bottom | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 🗑️ Delete | Profile header | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 📄 Create CV | Profile header, Generated CVs, CVs page | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Generated CVs: open · download · delete | Profile | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Documents & Fields: upload · open · 🖨 Print slip · refine photo | Profile | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Labor ID (click to change) | Profile | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Notes | Profile | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Prioritize (during a move) | Profile header, list cards | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 📋 Checklist (new or add) | Selection bar | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 📥 Excel download / other formats | Selection bar | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Open profile | List cards, broker lists, missing sheet | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 📄 Make her CV (step box) | AI Actions | ● | ● |  |  |  |  |  |  |  |  |  |  |
| Musaned: Add candidate | AI Actions |  | ● | ● |  |  |  |  |  |  |  |  |  |
| Musaned: Add from Musaned | AI Actions |  | ● | ● | ● |  |  |  |  |  |  |  |  |
| Musaned: Check if chosen | AI Actions |  |  | ● | ● |  |  |  |  |  |  |  |  |
| Check now (Musaned list of new selections) | Profiles page, Waiting tab |  |  | ● |  |  |  |  |  |  |  |  |  |
| 💬 Send CV to agents on WhatsApp | Profile, selection bar |  |  | ● |  |  |  |  |  |  |  |  |  |
| Day by day / FMOL (the daily check-up) | Profile |  |  | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |
| Musaned: Delete from Musaned | AI Actions |  |  | ● | ● | ● | ● |  |  |  |  |  | ● |
| Wafid: Book medical | AI Actions |  |  |  | ● | ● |  |  |  |  |  |  |  |
| Wafid: Appointment slip | AI Actions |  |  |  | ● | ● |  |  |  |  |  |  |  |
| Wafid: Check result | AI Actions |  |  |  |  | ● | ● |  |  |  |  |  | ● |
| Medical battery (set the date) | Profile header |  |  |  | ● | ● | ● | ● | ● | ● | ● | ● |  |
| Musaned: EPRO approve | AI Actions |  |  |  |  |  | ● | ● |  |  |  |  |  |
| 🛂 Tasheer appointment / Make Tasheer (group) | AI Actions, selection bar |  |  |  |  |  |  | ● | ● |  |  |  |  |
| 🛡️ Insurance certificate / Make insurance (group) | AI Actions, selection bar |  |  |  |  |  |  |  | ● | ● |  |  |  |
| Visa: Make visa (Enjaz) | AI Actions |  |  |  |  |  |  |  |  | ● | ● |  |  |
| Visa: Find application number | AI Actions |  |  |  |  |  |  |  |  | ● | ● |  |  |
| Visa: Pay visa fees | AI Actions |  |  |  |  |  |  |  |  | ● | ● |  |  |
| Visa barcodes: find / type the application number | Profile |  |  |  |  |  |  |  |  | ● | ● | ● |  |
| 🖨 Print for embassy / Print embassy | Profile, selection bar |  |  |  |  |  |  |  |  | ● | ● | ● |  |
| LMIS: Police certificate | AI Actions |  |  |  |  |  |  |  |  |  | ● | ● |  |

Notes

- These go beyond "own stage + next" on purpose. Day by day / FMOL is the Musaned check every 2 hours, so it shows from Waiting to Ready. The medical battery shows from Selected on. Delete from Musaned shows from Waiting to EPRO, and on Unfit. Wafid check also shows on Unfit, for a re-check. The embassy print and the visa barcodes also show on Ready, for a reprint.
- The selection bar shows a button when at least one ticked girl's stage allows it. Each girl is still checked by the server before it starts.
- The Profiles page tabs, the CVs page (Templates, Add from Musaned, New CV, delete a CV), the checklists and the broker lists are not tied to a stage, so they are unchanged.
- The phone hides the AI Actions and the PC-only selection-bar robots as before (`onPhone()`). The stage rule applies on top of that.
- After the EPRO the step pills on AI Actions stay, so the order can still be dragged. A pill whose box has nothing for her stage is dimmed and does not open.
