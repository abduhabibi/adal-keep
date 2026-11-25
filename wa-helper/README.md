# adal-wa-helper

One WhatsApp sign-in on this PC, without a browser (Baileys 7.0.0-rc14). A program of
its own (GPL-3.0, because Baileys uses libsignal, which is GPL-3.0): Adal Keep starts it
and talks to it in JSON lines (services/waOwn.js). It is not in a release.

Build (on this PC): `node wa-helper/build.mjs` → `wa-helper/out/wa-helper.mjs`, and its
SHA-256 goes into `adal-keep-backend/src/services/waOwn.js` (HELPER_SHA): no other file is ever run.
Install: copy it to `backend/data/wa-helper/wa-helper.mjs` on the PC.

In:  {"id":1,"cmd":"start"|"send"|"check"|"revoke"|"text"|"logout", ...}
Out: {"id":1,"ok":true,"result":…} · {"event":"state",…} · {"event":"ack","message_id":…,"ack":2}
