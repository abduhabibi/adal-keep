ADAL KEEP - USB INSTALL
=======================

The files are numbered in the order you use them.

  1 - PREPARE (once, needs internet).bat
  2 - Install Adal Main.exe          the main (server) PC
  3 - Install Adal Companion.exe     every employee PC
  deps\                              filled by step 1 - do not touch


1. PREPARE  (once per USB, on any Windows PC with internet)
   Double-click it and wait for DONE in green (about 5 minutes).
   It downloads Node.js, the server packages and the Brave browser
   into deps\. Running it again later is quick: what is already on
   the USB is kept.

2. MAIN PC
   Double-click, click YES on the admin prompt. Nothing to answer.
   Installs to C:\AdalKeep, starts with Windows, opens on
   http://localhost:4000 . Brave installs by itself in the background.

3. EMPLOYEE PCs
   Double-click, click YES. The Companion starts with Windows and
   finds the main PC on the network by itself.


UPDATES
   Settings page > Check updates (needs internet), or run
   "2 - Install Adal Main.exe" again. Data and documents are kept.

IF SOMETHING GOES WRONG
   "This USB is not prepared yet"     run step 1 first.
   PREPARE shows FAILED               read deps\prepare.log, run it again.
   Install failed                     read C:\AdalKeep\install.log.
   Server problems                    C:\AdalKeep\backend\data\server.log
   Employee PC cannot find the main PC:
      same network? main PC on? Or create
      C:\AdalKeepCompanion\companion.conf with one line
      ADAL_HOST_URL=http://<main PC IP>:4000   and restart the PC.

NEEDS
   Windows 10 (1803+) or 11, 64-bit, admin password, all PCs on the
   same network. Silent install for IT: add /S.

UNINSTALL
   Settings > Apps > Adal Keep. The database and documents in
   C:\AdalKeep stay; delete that folder by hand to remove them.

Adal Software PLC - 2026
