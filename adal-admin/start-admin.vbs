' Adal Keep Admin on Windows (Start menu / desktop shortcut): starts the panel
' out of sight when it is not running, then opens it in its own window
' (Microsoft Edge app window: no browser bar, its own profile).
Option Explicit
Dim sh, fso, here, up, i, edge
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

Function PanelUp()
  PanelUp = (sh.Run("cmd /c curl -s -m 2 -o nul http://localhost:4100/", 0, True) = 0)
End Function

If Not PanelUp() Then
  sh.Run """C:\AdalKeep\runtime\node.exe"" server.mjs", 0, False
  For i = 1 To 20
    WScript.Sleep 500
    If PanelUp() Then Exit For
  Next
End If

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=http://localhost:4100 --user-data-dir=""" & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.adal-keep\admin-window"" --no-first-run --window-size=1440,900", 1, False
Else
  sh.Run "http://localhost:4100", 1, False
End If
