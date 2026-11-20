ADAL KEEP - USB INSTALL
=======================

The files are numbered in the order you use them.

  1 - PREPARE (once, needs internet).bat
  2 - Install Adal Main.exe          the main (server) PC
  3 - Install Adal Companion.exe     every employee PC
  deps\                              filled by step 1 - do not touch


1. PREPARE  (once per USB, on any Windows PC with internet)
   Double-click it and wait for DONE in green (about 5 minutes).
   It downloads Node.js and the server packages into deps\.
   A USB made by the build already has all of this, Adal Browser too. Running it again later is quick: what is already on
   the USB is kept.

2. MAIN PC
   Double-click, click YES on the admin prompt. Nothing to answer.
   Installs to C:\AdalKeep, starts with Windows, and opens as an
   app from its icon. Adal Browser comes with it, nothing to download.

3. EMPLOYEE PCs
   Double-click, click YES. An "Adal Keep" icon appears on the
   desktop and it starts with Windows. It finds the main PC on the
   network by itself and opens the main PC's Adal Keep.
   If it cannot find it, a page "Looking for the main Adal Keep PC"
   opens: on the MAIN PC open Settings > Main PC, copy the address
   under "Addresses of this main PC" (e.g. 192.168.1.20:4000) and
   type it there.


4. PHONES (optional)
   Install the Adal Keep app from "5 - Phone app" and type the main
   PC's number (Settings > Main PC). It works on any internet.




SIGN-IN CODES
   Musaned and LMIS codes are typed by a person. When a run needs
   one, its tab comes to the front and Adal Keep rings once; type
   the code and the run continues by itself. Runs share one
   sign-in: while LMIS (or Musaned) is signed in in one tab, the
   next runs use it and ask for no new code.


UPDATES
   Settings page > Check updates (needs internet), or run
   "2 - Install Adal Main.exe" again. Data and documents are kept.

IF SOMETHING GOES WRONG
   "This USB is not prepared yet"     run step 1 first.
   PREPARE shows FAILED               read deps\prepare.log, run it again.
   Install failed                     read C:\AdalKeep\install.log.
   Server problems                    C:\AdalKeep\backend\data\server.log
   Employee PC cannot find the main PC:
      - main PC on, Adal Keep open on it?
      - run "2 - Install Adal Main.exe" again on the MAIN PC once:
        it fixes the Windows firewall there (data is kept).
      - type the main PC's address on the "Looking for the main
        PC" page (see step 3).
      - still nothing from the same Wi-Fi: the router keeps Wi-Fi
        PCs apart ("guest network" / "AP isolation"). Use a cable or
        the normal (not guest) Wi-Fi.

NEEDS
   Windows 10 (1803+) or 11, 64-bit, admin password, all PCs on the
   same network. Silent install for IT: add /S.

UNINSTALL
   Settings > Apps > Adal Keep. The database and documents in
   C:\AdalKeep stay; delete that folder by hand to remove them.

Adal Software PLC - 2026
