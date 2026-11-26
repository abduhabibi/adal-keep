#!/bin/bash
# usage: setprefs.sh on|off "account text"
export ANDROID_ADB_SERVER_PORT=15037 PATH=$HOME/Android/Sdk/platform-tools:$PATH
ON=$1; ACC=$2
adb shell am force-stop com.adalkeep.phone
UID_=$(adb shell stat -c %u /data/data/com.adalkeep.phone | tr -d '\r')
cat > ${TMPDIR:-/tmp}/adal-sms.xml <<XML
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <boolean name="on" value="$([ $ON = on ] && echo true || echo false)" />
    <string name="url">http://10.0.2.2:18080</string>
    <string name="anon">mock-anon</string>
    <string name="agency">agency-1</string>
    <string name="email">phone@test.local</string>
    <string name="password">pw</string>
    <string name="account">$ACC</string>
</map>
XML
adb push ${TMPDIR:-/tmp}/adal-sms.xml /data/data/com.adalkeep.phone/shared_prefs/adal-sms.xml >/dev/null
adb shell chown $UID_:$UID_ /data/data/com.adalkeep.phone/shared_prefs/adal-sms.xml
adb shell restorecon /data/data/com.adalkeep.phone/shared_prefs/adal-sms.xml
adb shell am start -n com.adalkeep.phone/.MainActivity >/dev/null
sleep 5
adb shell input keyevent KEYCODE_HOME
