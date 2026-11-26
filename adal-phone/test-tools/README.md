# Testing the LMIS SMS forwarding on the Pixel 8 emulator

What it exercises: the installed phone app (SmsCodeReceiver) receives an SMS, keeps only LMIS codes, sends them over the "online link"
(here a mock of Supabase: sign-in + keep_calls) to the PC side (the real routes/lmisAccounts.js + services/smsCodes.js), which types the
code into the LMIS sign-in tab of the right account (two mock LMIS pages, "PC A" = nuzla, "PC B" = ZAD, in a headless browser).

1. Emulator: `export ANDROID_ADB_SERVER_PORT=15037` (Traccar holds 5001-5250), `emulator -avd Pixel_8 -no-window -no-audio -ports 5584,5585 ...`
2. `adb install -r adal-keep-backend/src/phone-app/AdalKeep.apk`; `adb shell pm grant com.adalkeep.phone android.permission.RECEIVE_SMS`.
3. `node adal-keep-backend/scripts/sms-e2e-harness.mjs` (mock online link on :18080 for the phone = 10.0.2.2:18080; control on :18090).
4. Build the SMS tool once: `javac -cp $ANDROID_HOME/platforms/android-35/android.jar -d out SendSms.java && d8 --release --lib <android.jar> --output . out/SendSms.class && zip sendsms.jar classes.dex && adb push sendsms.jar /data/local/tmp/`.
5. `python3 sms-scenario.py [one two non twice off asleep closed nobody]`.

Why SendSms: this emulator's modem is not available (RADIO_NOT_AVAILABLE, so `adb emu sms send` is accepted but never delivered). SendSms hands the
app the same broadcast the radio would (SMS_RECEIVED with a real 3GPP SMS-DELIVER PDU) through the activity manager, as root. It does not test
Android's own permission gate (a root broadcast is delivered even when RECEIVE_SMS is revoked) nor the phone's modem.
setprefs.sh writes the app's `adal-sms` preferences (what Settings → "Send LMIS codes" saves) because the settings page needs a paired PC.
