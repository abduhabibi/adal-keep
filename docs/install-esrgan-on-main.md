# Installing the AI Refine (Real-ESRGAN) on Main — steps

Nothing here downloads anything by itself: the app never fetches the model. A person puts the file there.
The AI way is off until step 4. Steps 1–3 change nothing in how Adal Keep works.

Which folder: the app's backend folder is the one that holds `eng.traineddata` (next to `main.js`). Call it `<APP>`.
Find it in PowerShell: `Get-ChildItem C:\AdalKeep -Recurse -Filter eng.traineddata | Select -First 1 | % DirectoryName`

1. **Put the file** at `<APP>\data\models\realesr-general-x4v3.onnx` (make the `data\models` folder if it is not there).
2. **Check it** (both must match exactly, otherwise the app refuses the file — nothing else to do):
   ```
   (Get-Item "<APP>\data\models\realesr-general-x4v3.onnx").Length                         # 4866417
   (Get-FileHash "<APP>\data\models\realesr-general-x4v3.onnx" -Algorithm SHA256).Hash.ToLower()
   # 1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112
   ```
3. **The runtime**: `<APP>\node_modules\onnxruntime-node` must exist (it is in package.json). If the folder is missing, STOP here and
   tell me — installing it is a separate decision (it is a native package of some 100 MB).
4. **The setting**: add one line to `<APP>\.env` (the same file that holds the other settings): `ADAL_REFINE_ESRGAN=1`.
   Do NOT set `ADAL_LOCAL_ENHANCE` (that is the older path, a different way).
5. **Restart** Adal Keep the way you restart it after an update (the new setting is read at start).
6. **Test with a made-up portrait** (no real photo; takes up to 3 minutes per size on this PC; use the PC's own node, from `<APP>`):
   ```
   cd <APP>
   node scripts\esrgan-check.mjs C:\Temp\esrgan-out --size 2k
   ```
   Expected: `model ...: OK (size and sha256 match)`, `onnxruntime-node: found`, then a line
   `2k esrgan -> esrgan 30%  1536x2048 ... vs-input NN dB, colour 0.x` with **vs-input >= 34 dB and colour <= 1**, and
   `RESULT: the AI way works on this PC within the limits`. A lower percentage (20 or 10) is fine; `-> plain` with a note means
   the AI was refused by its guards or could not run (the note says why; send it to me). Look at `C:\Temp\esrgan-out\2k-esrgan.jpg`
   next to `2k-plain.jpg`: they must look like the same picture.
7. **In the app**: `http://127.0.0.1:4000/api/photo-refine/status` must show `"esrgan":true`; then on a profile's Photo, Refine shows the
   box "A very little AI cleaning". Tick it only for a test picture first.

Undo: delete the `ADAL_REFINE_ESRGAN` line and restart (the file may stay).
