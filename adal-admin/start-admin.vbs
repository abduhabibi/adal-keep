' Adal Keep Admin on Windows (Start menu / desktop shortcut): starts the panel
' out of sight when it is not running, then opens it in its own window
' (Microsoft Edge app window: no browser bar, its own profile).
'   start-admin.vbs           start (if needed) and open the window
'   start-admin.vbs /server   only start it (at Windows sign-in, from Startup)
' What it did is written to launcher.log beside it.
Option Explicit
Dim sh, fso, here, i, edge, onlyServer, logFile, ok, waitNote
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
onlyServer = (WScript.Arguments.Count > 0)
If onlyServer Then onlyServer = (LCase(WScript.Arguments(0)) = "/server")

Sub Note(t)
  On Error Resume Next
  Set logFile = fso.OpenTextFile(here & "\launcher.log", 8, True)
  logFile.WriteLine Now & "  " & t
  logFile.Close
End Sub

Function PanelUp()
  PanelUp = (sh.Run("cmd /c curl -s -m 2 -o nul http://127.0.0.1:4100/", 0, True) = 0)
End Function

If PanelUp() Then
  Note "already running"
Else
  If Not fso.FileExists("C:\AdalKeep\runtime\node.exe") Then
    Note "C:\AdalKeep\runtime\node.exe is missing"
    If Not onlyServer Then MsgBox "Adal Keep Admin cannot start: Adal Keep is not installed on this PC (C:\AdalKeep\runtime\node.exe is missing).", 16, "Adal Keep Admin"
    WScript.Quit 1
  End If
  Note "starting the panel"
  sh.Run "cmd /c ""C:\AdalKeep\runtime\node.exe"" server.mjs >> admin.log 2>&1", 0, False
  ok = False
  For i = 1 To 60
    WScript.Sleep 500
    If PanelUp() Then ok = True: Exit For
  Next
  If Not ok Then
    Note "the panel did not start within 30 s (see admin.log)"
    If Not onlyServer Then MsgBox "Adal Keep Admin did not start within 30 seconds." & vbCrLf & vbCrLf & "What it said is in:" & vbCrLf & here & "\admin.log", 48, "Adal Keep Admin"
    WScript.Quit 1
  End If
  Note "panel up after " & (i / 2) & " s"
End If

If onlyServer Then WScript.Quit 0

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=http://localhost:4100 --user-data-dir=""" & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.adal-keep\admin-window"" --no-first-run --no-default-browser-check --window-size=1440,900", 1, False
  Note "window opened"
Else
  sh.Run "http://localhost:4100", 1, False
  Note "opened in the default browser"
End If
