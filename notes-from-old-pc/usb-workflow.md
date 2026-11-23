---
name: usb-workflow
description: "After rebuilding the installer, always copy it onto the user's physical USB too (mounted at /media/abduhabibi/ADALKEEP — label ADALKEEP since it was reformatted on 2026-10-20)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e9919e7d-7360-49b4-baf2-5f2a94df64bc
  modified: 2026-10-18T09:05:27.068Z
---

When the system changes, update both the project folder (`bash adal-installer/build-installer.sh` → `Adal Keep USB/`) and the physical flash drive (`/media/abduhabibi/ADALKEEP/Adal Keep USB/`). Do NOT eject it after copying (the user said on 2026-10-27 "don't eject the USB always after build"): just `sync` so the data is written, and leave it mounted for the next build.

**Why:** the user said on 2026-10-19 to apply everything to the USB when finished, "and that should be always okay". Do it without asking, as the last step of every change. Earlier, on 2026-10-18, they said "you should edit both my folder inside my PC and the USB too" after I had only rebuilt the local folder.

**How to apply:** after a rebuild, copy the installers, the PREPARE .bat, README and deps/prepare-deps.ps1, then verify checksums. Keep the USB's prepared `deps/` unless `deps/source.sha` differs (then the user must re-run PREPARE on Windows). Related: [[adal-licensing]].

Release branch (since 2026-10-22): installed PCs check GitHub's `release` branch for updates (the installer's .env has GITHUB_BRANCH=release). After a committed build goes onto the USB, push that same commit to `release` as well as `main`, so "Check for updates" on PCs installed from the USB says up to date. The user wants no update offered between USB builds.
