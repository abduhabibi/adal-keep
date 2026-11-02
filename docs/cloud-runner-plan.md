# Cloud runner — plan

**Goal:** a button pressed on any PC or phone runs on a fast computer with fast
internet, not on the agency's old PC. The person only watches the run live, types
the OTP when the portal asks, and presses Save at the end.

## Does it make Adal Keep faster? Yes — for the runs

Where the time goes today, on an agency PC:

| Step | Agency PC (8 GB, Ethiopian line) | Cloud runner |
|---|---|---|
| Open Brave + portal | 10–40 s (Brave is heavy on 8 GB) | 1–3 s (browser already open) |
| Upload passport, photo, medical … | 5–60 s per file (upload speed) | under 1 s per file |
| Get the documents | from the PC's disk | from the Telegram backup (now online 3 s after they arrive) |
| What the person's device carries | the whole portal | a live picture (~40 KB per frame) and clicks / the OTP |

What it does **not** speed up: the portals themselves (Musaned, LMIS …) and the
person typing the OTP. The pages (profiles, search, CVs) are already fast: the
phone reads them from Supabase, the PC from its own disk.

## How it works

1. **The button.** A run (e.g. *Add to Musaned*) is written to Supabase
   (`keep_jobs`: agency, profile, workflow). Realtime tells the runner within ~1 s.
2. **The runner** is Adal Keep's own robot code (the same `worker.js` workflows)
   in a container, `RUNNER=1`:
   - the profile's details come from the agency's online copy (cloudSync already puts them there);
   - the documents come from the agency's Telegram backup (the index and its key are in `keep_meta /_backup`);
   - one browser, one tab per run, signed-in portals kept per agency (Musaned asks the OTP only when its sign-in has expired).
3. **The person watches it live.** The runner serves the run's tab as pictures
   and takes clicks and typing over its own HTTPS address, with a one-time token
   per run. Adal Keep already has this screen for the phone
   (`/automations/:id/screen` and `/input`); the same viewer opens on the PC and the phone.
4. **OTP and captcha.** The run pauses on the OTP / captcha page and the viewer
   pops up at once; the person types it. Nothing is stored or guessed (same rule as today).
5. **The end.** The run stops on the finished page with *Save* for the person,
   exactly as on the PC today; what it learned (Musaned number, contract …)
   goes back through Supabase to the agency's PC.

## Where it runs — no bank card needed

| Host | Card? | Fits? | Notes |
|---|---|---|---|
| **Hugging Face Spaces** (Docker, free CPU: 2 vCPU · 16 GB) | **No** — email only | Yes, to start | Free; sleeps after 48 h idle (wakes in ~30 s); US/EU servers; files on it are temporary (fine: documents come from Telegram) |
| Oracle Cloud free (Jeddah) | Yes | Best (Saudi IP, 24 GB) | When a card is available |
| A spare strong PC at Adal's office | No | Good | Fast if its internet is fast; must stay on |
| Any VPS (Hetzner, Contabo …) | Yes | Best for many agencies | ~5–10 €/month |

**Recommendation:** start on **Hugging Face Spaces** (no card), with Musaned only.
Move to Oracle Jeddah or a VPS when there is a card — the container is the same.

**Risk to check first:** Saudi portals may show more captchas, or refuse sign-in,
from a foreign data-centre address. Step 1 below tests exactly that before anything else is built.

## Steps

1. **Probe (½ day):** a Space with Brave opens Musaned's sign-in page and the
   viewer shows it on the phone. Does Musaned accept that address?
2. **Musaned add candidate end to end (2–3 days):** job → runner → documents from
   Telegram → OTP on the phone → finished page → Save.
3. **LMIS, Wafid, visa, insurance (1–2 days each).**
4. **Fallback:** runner busy, asleep or failing → the run goes to the agency PC as today.

## What is needed from you

- A **Hugging Face account** (email only) and a *write* access token, given to
  Adal Keep only through `.env` on Adal's PC (never in chat or the repository).
- Which agency to try first.
