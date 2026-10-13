=====================================================================
 ADAL KEEP  -  USB INSTALL GUIDE
 (documents, AI extraction, verification, police clearance)
=====================================================================

WHAT IS ON THIS USB STICK
  AdalKeep-Setup.exe   one installer, two roles (chosen inside the setup)
  README-USB.txt       this file
  adal.ico             icon (the installer uses it for the shortcuts)

You install it TWICE in a normal office:
  * once on the SERVER PC    (the main computer - database + web app)
  * once on every EMPLOYEE PC (small companion that sends scans over)


BEFORE YOU START
  - Windows 10 or 11, 64-bit.
  - Server PC: about 1 GB free disk space and 4 GB RAM.
  - Server PC and employee PCs must be on the SAME network (same router /
    switch). No internet is needed to run Adal Keep, but the internet is
    needed once if the installer should add the Brave browser.
  - You need the Windows administrator password for every PC.
  - The Server PC should stay switched on during office hours.
  - Everything uses port 4000 (plus UDP 45454 so the PCs find each other).
    The installer opens those ports in the Windows firewall by itself.


STEP 1 - SERVER PC  (do this first)
  1. Copy AdalKeep-Setup.exe to the PC (or run it straight from the USB).
  2. Right-click it -> "Run as administrator" (it will ask for elevation).
  3. On the role page choose:
        ( x ) Server PC  -  main computer (database, web app, AI, automations)
  4. Leave "Also install the Brave browser" ticked if this PC has internet.
  5. Keep the default folder  C:\AdalKeep  (short path, no spaces).
  6. Finish. The Adal Keep window opens and the web app starts on
        http://localhost:4000
  7. THE FIRST-RUN WIZARD asks for:
        - Company name (shown in the app header and the sidebar)
        - Company phone number
        - CEO phone number   (used by the police-clearance automations)
        - the CEO / admin login
     Fill it in carefully - the CEO phone number is what the automations
     dial, and the company name is what staff see everywhere.
  8. Write down the PC's LAN address (Admin > Network, or run `ipconfig`).
     It looks like  http://192.168.1.20:4000
     Employee PCs find it automatically, but you may need it for support.
  9. Adal Keep now starts automatically with Windows (minimised). You never
     have to open it by hand - just use the desktop shortcut when you want
     the window on screen.


STEP 2 - EVERY EMPLOYEE PC
  1. Run AdalKeep-Setup.exe as administrator.
  2. On the role page choose:
        ( x ) Employee PC  -  sends scanned documents to the Server PC
  3. Keep the default folder, finish, then RESTART the PC once.
  4. The "Adal Keep Companion" starts with Windows, finds the Server PC on
     the network by itself and watches the Desktop and Downloads folders.
  5. To open the Adal Keep web app on an employee PC, type the Server PC
     address in the browser, e.g.  http://192.168.1.20:4000


HOW DOCUMENTS FLOW
  1. The employee saves or scans a document (passport, police clearance)
     into Desktop or Downloads on his PC.
  2. The Companion waits until the file is finished writing, then sends it
     to the Server PC (no login needed on the employee PC).
  3. On the server the document is OCR-read (MinerU / PDF text / Tesseract)
     and filed in the tray, ready to be attached to a profile.
  4. The server shows THREE GREEN TICKS per passport:
        tick 1  READ      - text was found in the document
        tick 2  EXTRACTED - all passport fields were found
        tick 3  VERIFIED  - the MRZ check digits are valid (pure arithmetic,
                            so no AI mistake can fake this tick)
  5. Police clearance work is GATED: until a passport has all three ticks
     the police-clearance automation refuses to start for that profile.
     Press "Re-check" on the profile to run the ticks again after a better
     scan has been uploaded.


TROUBLESHOOTING
  Employee PC cannot find the server
     - Check both PCs are on the same network and the server PC is on.
     - On the server PC allow Adal Keep when Windows asks, or re-run the
       installer (it re-adds the firewall rules).
     - Pin the address by hand: put a file named  companion.conf  next to
       adal-companion.exe  (C:\AdalKeep\companion.conf) with one line:
           ADAL_HOST_URL=http://192.168.1.20:4000
       then restart the PC.
  "Port 4000 already in use"
     - Another Adal Keep (or a leftover node.exe) is running. Open Task
       Manager, end node.exe, then start Adal Keep again.
  Page does not open on the server PC
     - Run the desktop shortcut "Adal Keep": it waits for the server and
       opens the browser. Keep that window open while the staff work.
  Everything feels slow
     - Keep the server PC awake (Power Options: never sleep) and connect it
       with a network cable rather than Wi-Fi.
  Logs
     - Server:    C:\AdalKeep\backend\data\server.log
     - Companion: the minimised "Adal Keep Companion" window on the PC.
  Backups
     - Server PC: Admin > Backups in the web app. The database and the
       uploaded documents live in C:\AdalKeep\backend\data - copy that
       folder to be safe.


SILENT / BULK INSTALL (for IT staff)
  AdalKeep-Setup.exe /S                installs the Server PC role
  AdalKeep-Setup.exe /S /COMPANION     installs the Employee PC role
  Both are silent, need administrator rights and never start the app.


UNINSTALL
  Settings > Apps > "Adal Keep" > Uninstall (or the Start-menu shortcut).
  On the SERVER PC this deletes the database and all uploaded documents -
  back them up first.


FIRST TRAINING RUN (30 minutes, do this once)
  1. On the server PC: add one employee user and open one profile.
  2. On his PC: scan a real passport -> save it to Downloads.
  3. Watch the tray on the server: it should appear with three green ticks.
  4. Attach it to the profile and let the police-clearance automation run.
  5. Only after this test, hand the USB stick to the rest of the office.

Adal Software PLC - 2026
