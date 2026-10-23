ADAL KEEP - USB INSTALL
=======================

The files are numbered in the order you use them.

  1 - PREPARE (once, needs internet).bat
  2 - Install Adal Main.exe          the main (server) PC
  3 - Install Adal Companion.exe     every employee PC
  deps\                              filled by step 1 - do not touch


1. PREPARE  (once per USB, on any Windows PC with internet)
   Double-click it and wait for DONE in green (about 5 minutes).
   It downloads Node.js, the server packages, the Brave browser and
   Tailscale into deps\. Running it again later is quick: what is already on
   the USB is kept.

2. MAIN PC
   Double-click, click YES on the admin prompt. Nothing to answer.
   Installs to C:\AdalKeep, starts with Windows, opens on
   http://localhost:4000 . Brave installs by itself in the background.

3. EMPLOYEE PCs
   Double-click, click YES. An "Adal Keep" icon appears on the
   desktop and it starts with Windows. It finds the main PC on the
   network by itself and opens the main PC's Adal Keep.
   If it cannot find it, a page "Looking for the main Adal Keep PC"
   opens: on the MAIN PC open Settings > Main PC, copy the address
   under "Addresses of this main PC" (e.g. 192.168.1.20:4000) and
   type it there.


4. PHONES (optional)
   Turn on https first (see TAILSCALE, step 3). On the phone open the
   main PC's https address in Chrome (Android) or Safari (iPhone),
   then menu > "Add to Home screen". The Adal Keep icon is the app.


TAILSCALE - another branch, home, phones  (free)
   A private link between the agency's devices, from anywhere.
   Nothing is opened to the internet.
   1. Both installers (2 and 3) install Tailscale from the USB. On
      each PC click the Tailscale icon (bottom right, near the clock)
      > Log in, and sign in with the agency's Google account.
   2. Laptops at home and phones: install Tailscale (tailscale.com,
      App Store / Play Store) and sign in with the SAME account.
   3. Phones only: login.tailscale.com > DNS > MagicDNS on and
      HTTPS Certificates > Enable. Then on the main PC: Settings >
      Main PC > "Turn on https for phones".
   4. Main PC: Settings > Main PC shows its Tailscale address
      (100.x.x.x:4000). Type it on the other device:
        - employee PC: the "Looking for the main PC" page
        - full install in a branch: Settings > Main PC >
          "Another PC is the main PC"
        - laptop / phone: open it in the browser.


SIGN-IN CODES  (Settings > Sign-in codes, on the main PC)
   Musaned: paste the authenticator key once; Adal Keep types the
   6-digit code itself. LMIS: a phone in the office forwards the
   SMS codes (the card shows how, Android or iPhone).


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
        PCs apart ("guest network" / "AP isolation"). Use a cable,
        the normal (not guest) Wi-Fi, or Tailscale.

NEEDS
   Windows 10 (1803+) or 11, 64-bit, admin password, all PCs on the
   same network. Silent install for IT: add /S.

UNINSTALL
   Settings > Apps > Adal Keep. The database and documents in
   C:\AdalKeep stay; delete that folder by hand to remove them.

Adal Software PLC - 2026
