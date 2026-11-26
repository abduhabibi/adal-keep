# How a robot knows where it is (site maps)

The owner, 26 Nov 2026: "the robots don't know where they are." A robot used to follow a fixed list of steps: open
the root, sign in, click HR Pool, click Add. After a restart, a reload, a person's click or a slow page, that list
no longer matched the tab, so the robot scrambled through pages or reloaded the root.

## The idea: locate, then go

1. **A site map per site, as data** (`src/services/siteMap/<site>.js`):
   - **Screens**, each with a recogniser read off the page itself (address and marks on the page, never AI). A
     recogniser either says the screen for sure or says nothing.
   - **Actions** between screens, for example `click HR Pool: dashboard → hr-pool`. Each action carries:
     - the screens it starts from and the screens expected after it;
     - a cost (a click is cheaper than loading an address);
     - whether it may be repeated.
2. **Before every step the screen is read.** The next action is the cheapest path on the map from where the tab is
   to the goal. Memory of the last place is only a hint, so this works after restarts, reloads and a person's clicks.
3. **Every action is checked.** The page must show one of the expected screens. The wait ends on the page's own
   sign, with the old sleep as the upper limit. If the check fails, the screen is read again and the path planned
   again. There are a few steps at most, and the run itself is never retried (one run, one try).
4. **An unknown screen** goes to JEV with a screenshot and the goal. JEV gets a list of allowed actions only (safe
   ones, never Save, Submit, Log out, a captcha or a code) and picks one. The result is checked like any other
   action, at most 3 times a run. Each unknown screen is saved (page HTML with digits masked, plus a picture) in
   `data/unknown-screens/<site>/` so it can become a known screen.
5. **Person gates are on the map:** the captcha tick, LMIS and Musaned codes, and the final Save. When the robot
   reaches one, it stops and says so. It never acts there.
6. **One session owner per site and account** (tabManager, ONE_PAGE): one tab, shared through a lease by runs, checks
   and the session keeper. Keep-alive moves only to known safe screens.
7. **Read fast, write carefully:** reads use the site's own data calls where they exist (siteApi.js, scanListByApi).
   Writes go through the page with pasteAll and are read back.
8. **Checkpoints:** each checked step is written to the run's context. A step that must not be repeated (Save, an
   upload already done) is never done twice.
9. **Trace:** each run's log gets one line per step (screen, action, time). The per-step totals across runs are kept
   in `data/step-times.json`, so the slow step is known.

## The engine (`src/services/siteMap/engine.js`)

- `recognise(map, look)` → the screen's name, or `''` when it is not sure.
- `plan(map, from, goal)` → the cheapest list of actions.
- `goTo(page, map, goal, opts)` → `{ ok, screen, steps, gate?, why? }`. It reads, plans, acts and checks; it asks
  JEV for an unknown screen and stops at a gate.

## Rollout

The map drives one part at a time, behind `ADAL_SITE_MAP=0` (off switch: the old path). The old code stays until the
new path has passed replays of real pages.

1. Musaned: signed in → the HR Pool's Add Candidate pre-check (done first). Sign-in keeps its old path for now.
2. Musaned sign-in screens. Then Wafid, Enjaz, Tasheer, LMIS and insurance, one by one.

Everything so far is tested on mock sites with a mock JEV only.
