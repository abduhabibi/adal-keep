# Robots choose the best PC, and use less of it (2026-11-25)

## Which PC a run works on
Decided by itself at the start of each run (`selfAssign.js`), nobody asked, no setting. Every PC's `adal-companion`
is asked at once (`GET /robot/now`, 600 ms): processor busy now, cores, memory, battery, on the office network or not.
The one that would be done first does it, out of sight (headless); else the next best; else this PC, which is said in
the run's log. A run never waits for another PC. Measured on a mock office: three PCs, one hung: decided in 776 ms;
a real Adal Robots with one PC: 22–125 ms.

- **Why none was chosen before:** the hand-over was off (`ADAL_LAN_ROBOTS`); the PCs announced themselves to Adal
  Keep's memory, while the runs are placed in Adal Robots, whose list stayed empty; a PC on another release was left
  out (Main is updated by hand); one announcement that timed out (30 s) made a PC "gone" for 45 s.
- **Sign-ins:** a site's account goes back to the browser it signed in to (`signInHome.js`, 12 h). On a PC it was never
  signed in on, a person ticks once there (through the live view, as always). Cookies are not copied.
- **A PC that dies** while it works: asked every 5 s, let go after 3 misses; its run ends once, "… went away …",
  about 17 s after. Nothing is started or sent again by itself.
- **Off:** `ADAL_LAN_ROBOTS=0` on the main PC: every run there, as before. (CV PDFs and moves stay on the main PC
  unless `=1`.)
- **Needs:** a Companion with the new adal-companion program. One without `/robot/now` is used only on Main's release.
- **Known:** the browser's control line and its key go over the office network unencrypted (as before, now used by
  itself). Not tried on Windows PCs.

## Waiting for the tick
10 minutes everywhere (call, pause, log); a person at the tab then keeps it (as long again at most). A form over a minute
old is loaded fresh when a person opens it.

## Lighter: measured on 2 cores (Linux, Chrome, processor counted by the kernel for all its processes)
One whole mock Musaned run (sign-in, 40 s at the tick, code, Employment Requests, a form of 40 boxes and a photo; a
1.5 MB program, 24 pictures, 2 analytics on every page). The form is a stand-in: there is no mock of Musaned's own Add.

| | before | after (median of 3) |
|---|---|---|
| browser, the whole run | 9.2 s | 7.9 s |
| a minute's waiting, a still page | 1.8 s | 1.2 s |
| a minute's waiting, a page with moving pictures, its tab in front | 41 s | 17.6 s (20 of the 60 s awake) |
| … its tab behind another | 3.6 s | 1.3 s |
| the whole run with that page, in front | 65.6 s | 36.5 s |
| robot's program (node) | 3.5 s | 2.9 s |
| memory, highest | 480 MB | 456 MB (each pair −22 to −114 MB) |
| a fresh browser, first 100 s, nothing open | 3.7 s, 32 MB down | 2.2 s, 7 MB |

Item by item:

| Item | Kept? | Measured |
|---|---|---|
| Analytics and speed monitors blocked (`pageDiet.js`) | yes | Musaned's own front page: 109 → 103 programs, 338 → 315 KB, maze.co and its APM gone |
| Fonts from Google's font host too | yes | Wafid: 45 KB, 2 requests less |
| Pictures (blocked already) | yes | without our blocking: +2 s, +220 MB at the peak |
| A waiting page rests (`restPage.js`) | yes | 20 → 1 timer ticks a second, moving pictures stand still; awake and first picture in 67 ms |
| No component updates, sync, default apps | yes | −1.5 s and −25 MB of download after each fresh start |
| No pages kept for "Back" | yes | −100 MB or so at the peak |
| Empty tabs closed (`spareBlanks.js`) | yes | one process each |
| No Wafid standby on a weak PC | yes | a tab of about 100 MB; loading it costs 3.3 s the first time, 1.4 s after |
| GPU work in the browser's process | no | no difference (7.9 s) |
| Low-end mode; JavaScript lite mode | no | slower (8.5 and 10.0 s), no memory saved at the peak |
| One renderer limit | no | 7.2 s, within the noise; tabs would stop each other |
| No site isolation | no | no difference, and less safe |
| A smaller page (1280×720, 1024×600) | no | no difference without a window |
| Read by direct calls instead of pages | there already (`siteApi.js`) | nothing new |

Off: `ADAL_PAGE_DIET=0`, `ADAL_REST=0`, `ADAL_SPARE_BLANKS=0`, `ADAL_BROWSER_DIET=0`, `ADAL_WAFID_STANDBY=1` (keeps the tab).
Not measured: Windows (the window off-screen draws there; a lone tab never counts as unseen), the A4-5300B itself.
