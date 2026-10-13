ADAL KEEP - OFFLINE INSTALLER
=============================
WINDOWS: double-click install.bat (no admin rights needed)
LINUX:   ./install.sh

THE MODEL:
- Install ONLY on the master PC (the one that stays on).
- Master PC browser:   http://localhost:3000
- Other PCs (same network): http://<master-PC-IP>:3000
  (nothing is installed on those PCs - the browser IS the client)
- adal-companion folder = optional standalone offline copy for a PC
  with no network to the master. Never run both on the same PC.

Runs 100% offline. No AI calls. OCR works on-device.
AI classification is a future upgrade (swap offlineProcessor.js -> aiIngestion.js).

If Windows Firewall prompts on first start: allow Node.js on private networks.
