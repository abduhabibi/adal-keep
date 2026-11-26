#!/bin/bash
# usage: sendsms.sh FROM "text" [slot]  — one SMS to the phone app, as a real SMS_RECEIVED broadcast (see README.md)
export ANDROID_ADB_SERVER_PORT=${ANDROID_ADB_SERVER_PORT:-15037} PATH=$HOME/Android/Sdk/platform-tools:$PATH
adb shell "app_process -Djava.class.path=/data/local/tmp/sendsms.jar /system/bin SendSms com.adalkeep.phone '$1' ${3:-0} '$2'"
