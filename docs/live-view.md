# The robot's browser, live (2026-11-25)

## What was compared (measured, not read about)
This Linux PC (4 threads, Chrome headless, 1366×900, other work running too, so ±3 %). "Browser" = every process of the
robot's Chrome; with nobody watching it uses 4–8 %. **Not measured on the 2-core main PC.**

| Way | Still sign-in page | Typing 5 keys/s | First picture | Through a Companion | Captcha visible |
|---|---|---|---|---|---|
| Before: MJPEG `<img>` + a screenshot every second | 11 %, 55 KB/s | — | none on a still page (Chrome draws a part only when the next comes) | no (`<img>` cannot send the key) | yes |
| Before: `/screen` every 0.9 s | 9 %, each a full redraw (30–48 ms here, 2.4 s on Main) | same | 1 redraw | yes | yes |
| **Chosen: CDP screencast, one HTTP stream, only when the page changes** | **4–8 % = idle, 0 KB** | 29 %, 5 pictures/s | 30–60 ms new, 4 ms kept | yes | yes |
| Only changed tiles | +40 ms of processor a picture (unpack 32, compare 7, cut 1) | +20 % of a core | same | yes | yes |
| WebRTC (VP8, software) | 13 ms an encode; 13 % at 5 pictures/s with both ends in one browser; needs our script in the government page or a visible window | 13 % | not measured (a set-up of its own) | no (not through our HTTP hops) | yes |
| DOM mirror (Page view) | 7 % at 3 reads/s, 2 KB | 7 % | 20 ms | yes | **no** (another site's frame) |

WebSocket or a plain HTTP stream makes no difference in processor. The HTTP stream passes every hop there is today
(Adal Robots, a Companion's server, AdalKeep.exe `/lan-api`, adal-companion.exe) with their keys, so it was chosen.

**Tiles are for slow lines only** (under 300 KB/s, seen by itself): on the office network sending 60 KB costs 0.1 ms,
finding the tile 40 ms — on a 2-core PC the tile is the dear one. A picture the viewer has already (a blinking cursor)
is 9 bytes. Off: `ADAL_LIVE_TILES=0`; the whole new stream: `ADAL_LIVE2=0` (the older one is used).

## What was wrong
1. The expanded view was an `<img>`: from a Companion's online window it cannot send the key `/lan-api` asks for (broken
   picture, "Opening…" for ever), while the small view asked `/screen` through axios (1 picture a second).
2. Chrome draws a picture of an MJPEG stream only when the next comes: a still page stayed on "Opening…".
3. adal-companion.exe held the last 4 KB of a stream back.
4. Every view asked for its own stream, `/tab` every 1.5 s and a screenshot every second.

## Where the robot's browser should run
| | Main (A4-5300B, 2 threads, 7.5 GB) | 10RD4GN (i5-8365U, 8 threads, 16 GB) | a warm browser on Main |
|---|---|---|---|
| Work beside Adal Keep | 93–100 % busy already | room | keeps its memory, saves the start (not measured) |
| Clicks and pictures for a person | nothing between | one hop more on the office network (not measured) | — |
| Needs | nothing | see below | nothing |

### Proposal: Adal Robots on 10RD4GN (not built)
- **Queue:** it must be the agency's one copy, the main PC's SQLite. A second process may not open that file over the
  network (SQLite locks do not work on a share). So: a small queue service on Main (claim, log, step, result), asked
  with that PC's certificate (equal PCs), one job at a time, a lease of 60 s renewed while it works; Main takes the job back
  when the lease ends and marks it stopped (**never** started again by itself).
- **Passwords:** the vault key never leaves Main. Main gives the one account's name and password of the claimed job
  only, over the certificate channel, kept in memory only. The authenticator code is made on Main when asked.
- **Files:** the job's documents (passport, photo, slip) fetched on claim, erased after it.
- **Sign-ins (cookies):** they live in that PC's profile: every account signs in there once (a person's tick).
- **Live view:** the stream as built here; Main passes it on (one hop).
- **Safe order:** (1) the queue service with a switch, off; (2) a mock run end to end between two PCs; (3) one
  account's "Check if chosen" for a day; (4) the rest.
- This touches the main PC's server (new routes, certificates, vault), not only the robots' files, so it was not built.
  What exists already: `ADAL_LAN_ROBOTS=1` (remoteBrowsers.js) lets Main drive a Companion's browser: the pages are
  drawn there, the robot code, queue, passwords and files stay on Main. That takes the dear part (Chrome) off
  Main with nothing new, and is the first thing to try — one PC, one day, with the owner's yes.
