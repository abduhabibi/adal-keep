# Claims

Sessions write here what they are working on, so two sessions never change the same files.

## Released 2026-11-21 (release-5, from candidate-1)

These are on main and published; their claims are free:

- office-compute: robots on the best PC, remote browser view, sidebar browsers, human-step tasks. Released.
- done-and-tasheer: mark-as-done advances stage; Tasheer captcha by notification. Released.
- phone-buttons: every phone button tested on the emulator; clearing tasks (phone APK 1.96; rebuilt as 1.97 (98) with the tray-pull phone pages). Released.
- tray-pull: arrival pop-up, roomy tray, drag and paste onto fields. Released.
- transitions-fix: transitions in Adal Browser only. Released.
- Also in this release: runs waiting for Adal Browser are held back until their wait time (no more "started" loop).

## Active

- support-lan-key (2026-11-22, PC 192.168.1.17) DONE on main 4bda47e, installers rebuilt (not by update: needs reinstall or Adal Connect): support-setup.ps1 + usb/deps/adal-connect.ps1 keep Adal's adal-remote key next to the agency key; SSH firewall rule only from the LocalSubnet. Files: adal-installer/files/support-setup.ps1, adal-installer/usb/deps/adal-connect.ps1.
- rollback-notes (2026-11-22, this PC): one-click "Go back to previous version" on an agency's main PC (pre-signed rollback envelope in each release, LAN first, refused when the database is ahead) + "What's new" notes in publish-update.mjs shown once per PC. Files: adal-keep-backend/scripts/publish-update.mjs, adal-keep-backend/src/services/{rollback,whatsNew}.js (new), adal-keep-backend/src/services/lanRelease.js (recordInstalled only), adal-keep-backend/src/routes/systemUpdate.js, adal-keep-frontend/src/components/WhatsNewCard.jsx (new), the Updates box in adal-keep-frontend/src/pages/SettingsPage.jsx, tests/rollback.test.js, adal-companion/selfupdate.go (isNewerRelease: a signed way back from the release it runs).
- staff-roles (2026-11-22, this PC) ON MAIN, release pending: staff roles + permission toggles (Admin/Office/Data entry), enforced in the backend. Files: adal-keep-backend/src/services/staffRoles.js, src/routes/staffRoles.js, src/routes/employees.js, main.js (one guard line), cloudSync GLOBAL (one path); frontend EmployeesPage, lib/staffPerms.js, AuthContext, api.js (one header), a few hide-the-button lines.
- office-health (2026-11-22): released as 45e7d88 (staged 2 h; every PC gets it at 12:04). Free.
- whatsapp-link (2026-11-22 10:30, this PC): WhatsApp linking by 8-character code from the phone app, warm hidden browser, drop notice with one-tap relink, timings. Files: adal-keep-backend/src/services/whatsapp.js, src/routes/whatsapp.js, tests/whatsapp*.test.js, tenancy.js goOf (one line); adal-keep-frontend/src/components/WhatsAppCard.jsx, src/pages/WhatsAppLinkPage.jsx (new), App.jsx (one route); adal-phone build.gradle (version).
- stage-logic (2026-11-22): WhatsApp card "Make CV" for CV-skipped girls; no earlier-step badges after Selected. Files: adal-keep-frontend/src/lib/phase.js, pages/ProfilesPage.jsx, tests/waitingStage.test.js, selectionCheck.test.js.
- support-lan-key (2026-11-22 09:50, PC 192.168.1.17): support-setup.ps1 + usb/deps/adal-connect.ps1 keep Adal's adal-remote key next to the agency key; SSH firewall rule only from the LocalSubnet. Files: adal-installer/files/support-setup.ps1, adal-installer/usb/deps/adal-connect.ps1.
- rollback-notes (2026-11-22, this PC): one-click "Go back to previous version" on an agency's main PC (pre-signed rollback envelope in each release, LAN first, refused when the database is ahead) + "What's new" notes in publish-update.mjs shown once per PC. Files: adal-keep-backend/scripts/publish-update.mjs, adal-keep-backend/src/services/{rollback,whatsNew}.js (new), adal-keep-backend/src/services/lanRelease.js (recordInstalled only), adal-keep-backend/src/routes/systemUpdate.js, adal-keep-frontend/src/components/WhatsNewCard.jsx (new), the Updates box in adal-keep-frontend/src/pages/SettingsPage.jsx, tests/rollback*.test.js.
- staff-roles (2026-11-22, this PC): staff roles + permission toggles (Admin/Office/Data entry), enforced in the backend. Files: adal-keep-backend/src/services/staffRoles.js, src/routes/staffRoles.js, src/routes/employees.js, main.js (one guard line), cloudSync GLOBAL (one path); frontend EmployeesPage, lib/staffPerms.js, AuthContext, api.js (one header), a few hide-the-button lines.
- run-history (2026-11-22, branch claude/gifted-chaum-86fe69): robot run history page, 30 days, small stop pictures. Files: backend src/services/runHistory.js, src/routes/runHistory.js, migration 065, tests/runHistory.test.js; small hooks in worker.js (runJob), transition.js (startTransition), main.js; frontend pages/RunHistoryPage.jsx, App.jsx, Sidebar.jsx, i18n.js.
