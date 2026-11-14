# Windows' own screen crop (the same as Win+Shift+S), then the cropped picture
# from the clipboard as a PNG file. Used by POST /api/app/screen-clip.
#   screen-clip.ps1 -Out <png path> [-WaitSeconds 120]
# Prints "ok" when the picture was saved, "none" when nothing was cropped in time.
param([Parameter(Mandatory = $true)][string]$Out, [int]$WaitSeconds = 120)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Adal -Name Clip -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'

$before = [Adal.Clip]::GetClipboardSequenceNumber()
Start-Process "ms-screenclip:"
$end = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $end) {
  Start-Sleep -Milliseconds 400
  if ([Adal.Clip]::GetClipboardSequenceNumber() -eq $before) { continue }
  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img) { $img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); Write-Output "ok"; exit 0 }
  }
  # Something else was copied meanwhile: keep waiting for the picture.
  $before = [Adal.Clip]::GetClipboardSequenceNumber()
}
Write-Output "none"
