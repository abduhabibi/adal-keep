#!/usr/bin/env bash
# Build the phone app (signed with ~/.adal-keep/phone-release.jks) and put it
# where every PC hands it out: adal-keep-backend/src/phone-app/ — installed
# PCs get it with their own update from GitHub, and phones that open Adal Keep
# update themselves from their PC. Bump versionCode in android/app/build.gradle
# first when the app changed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../adal-keep-backend/src/phone-app"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
# The app's own pages (for when the PC is off) + the connect screen.
( cd "$HERE/../adal-keep-frontend" && npm run -s build:phone >/dev/null )
cd "$HERE"
npx cap sync android >/dev/null
( cd android && ./gradlew assembleRelease -q )
mkdir -p "$OUT"
cp -f android/app/build/outputs/apk/release/app-release.apk "$OUT/AdalKeep.apk"
CODE=$(grep -oP 'versionCode \K\d+' android/app/build.gradle)
NAME=$(grep -oP 'versionName "\K[^"]+' android/app/build.gradle)
printf '{ "versionCode": %s, "versionName": "%s" }\n' "$CODE" "$NAME" > "$OUT/version.json"
echo "phone app $NAME ($CODE): $(du -h "$OUT/AdalKeep.apk" | cut -f1) → $OUT"
