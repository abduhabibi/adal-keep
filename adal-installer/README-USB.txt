=====================================================================
 ADAL KEEP  -  USB INSTALL GUIDE
=====================================================================

WHAT IS ON THIS USB
  Install Adal Main.exe                          the main (server) PC
  Install Adal Companion.exe                     every employee PC
  PREPARE - run once on a PC with internet.bat   fills the deps folder
  deps\                                          Windows dependencies
  README-USB.txt                                 this file


STEP 0 - PREPARE THE USB  (only once, needs internet)
  Do this on ANY Windows 10/11 64-bit PC that has internet.
  1. Plug in the USB.
  2. Double-click  "PREPARE - run once on a PC with internet.bat".
  3. Wait until it shows DONE in green (5-15 minutes). It downloads into
     the USB's deps folder:
        - Node.js for Windows
        - the server packages, built for Windows
        - the Brave browser installer
  4. Close the window and safely eject the USB.
  If it shows FAILED in red, read the message, fix it (usually: no
  internet), and run PREPARE again.
  You only repeat PREPARE when you get a NEW Adal Keep USB folder.


STEP 1 - THE MAIN PC  (once per office, needs no internet to install)
  1. Plug in the USB.
  2. Double-click  "Install Adal Main.exe"  and click YES on the Windows
     admin prompt. Nothing else to answer.
  3. It installs to C:\AdalKeep, installs Brave if it is missing, opens
     the firewall, starts the server and opens Adal Keep in the browser.
  4. From now on Adal Keep starts by itself when Windows starts.
     Address on this PC:  http://localhost:4000
     Address for other PCs: http://<this PC's IP>:4000  (run ipconfig)
  The AI document reading (Gemini / MinerU) needs internet while working.


STEP 2 - EVERY EMPLOYEE PC
  1. Plug in the USB.
  2. Double-click  "Install Adal Companion.exe"  and click YES.
  3. Done. The Companion starts with Windows, finds the main PC on the
     network by itself and sends new scans from Desktop and Downloads.


BEFORE YOU START
  - Windows 10 (version 1803 or newer) or Windows 11, 64-bit.
  - Main PC: about 2 GB free disk, 4 GB RAM, kept on in office hours.
  - All PCs on the SAME network. Ports: TCP 4000, UDP 45454 (the
    installers open them in the Windows firewall).
  - You need the Windows administrator password on every PC.


UPDATING
  Run the new "Install Adal Main.exe" over the old one. The database and
  the uploaded documents (C:\AdalKeep\backend\data.sqlite, data\,
  uploads\) are kept.


TROUBLESHOOTING
  "This USB is not prepared yet"
     - Do STEP 0 first.
  "could not finish installing (step: dependencies)"
     - Read C:\AdalKeep\install.log, run PREPARE again, then install again.
  Employee PC cannot find the main PC
     - Both on the same network? Main PC on?
     - Pin it by hand: create C:\AdalKeepCompanion\companion.conf with one
       line:  ADAL_HOST_URL=http://192.168.1.20:4000   then restart the PC.
  "Port 4000 already in use"
     - Restart the main PC.
  Logs
     - Install:   C:\AdalKeep\install.log
     - Server:    C:\AdalKeep\backend\data\server.log


SILENT INSTALL (IT staff)
  "Install Adal Main.exe" /S
  "Install Adal Companion.exe" /S
  (silent installs do not start the app; it starts at the next login)


UNINSTALL
  Settings > Apps > "Adal Keep" (or "Adal Keep Companion") > Uninstall.
  On the main PC the database and documents in C:\AdalKeep are KEPT;
  delete that folder by hand to remove them too.

Adal Software PLC - 2026
