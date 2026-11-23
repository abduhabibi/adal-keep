---
name: run-tabs-background
description: "Agent run tabs must keep working while the user works in other tabs; LMIS buttons only after \"Upload Complete\"; user wants JEV used as the verifier"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e9919e7d-7360-49b4-baf2-5f2a94df64bc
  modified: 2026-10-18T11:41:25.789Z
---

The user works in other tabs while runs go. A run tab must never need to be in front and must never be pulled to the front (no bringToFront). Focus emulation on the tab's CDP session (tabManager.setupTab) keeps a background tab "visible", drawing frames and running animations. This was measured on 2026-10-18 in the user's Brave: 120 frames in 2 s with it, 0 without.

LMIS ignores Add/Submit while its FilePond upload is still running. Press the button only after the window itself shows "Upload Complete", and press it again until the window closes (finishUploadWindow in lmisWorkflow.js). If the file is already up in a leftover upload window, finish that window; never close it.

**Why:** run #356 pressed Add too early, then closed the slip window and lost the slip. The user said "prioritize the tabs working by the agents over anything" and "make sure you use JEV for good".

**How to apply:** test LMIS changes on a mock page in a background tab of the user's Brave, created with Target.createTarget background:true. Close the test tab afterwards. JEV (TypeSafe) answered 402 "no credits" on 2026-10-18. The run now logs when JEV couldn't look, and tells the person in the hand-over message.
