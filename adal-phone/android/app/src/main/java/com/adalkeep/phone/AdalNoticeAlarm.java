package com.adalkeep.phone;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;

/**
 * The second way Adal Keep's notifications come with the app closed — also
 * after it was swiped away (asked on 2026-11-16). Android's own alarm wakes
 * this about every minute (while the phone sleeps Android stretches it, at
 * most to ~10 minutes), even in its deepest sleep; each wake looks at the bell
 * once (AdalNoticeJob.look) and sets the next. The job (AdalNoticeJob) keeps
 * running beside it. After a restart of the phone, or an update of the app,
 * both start again by themselves.
 */
public class AdalNoticeAlarm extends BroadcastReceiver {
    private static final String WAKE = "com.adalkeep.phone.NOTICE_WAKE";
    private static final long EVERY_MS = 60_000L;

    static void schedule(Context c, long inMs) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        Intent i = new Intent(c, AdalNoticeAlarm.class).setAction(WAKE);
        PendingIntent pi = PendingIntent.getBroadcast(c, 7201, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Allowed while the phone sleeps, with no special permission (not an exact alarm).
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + inMs, pi);
    }

    static void cancel(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        Intent i = new Intent(c, AdalNoticeAlarm.class).setAction(WAKE);
        PendingIntent pi = PendingIntent.getBroadcast(c, 7201, i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (am != null && pi != null) am.cancel(pi);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context c = context.getApplicationContext();
        boolean on = c.getSharedPreferences(AdalNoticeJob.PREFS, Context.MODE_PRIVATE).getBoolean("on", false);
        if (!on) return;
        String a = intent == null ? "" : String.valueOf(intent.getAction());
        // The phone restarted, or the app was updated: the job and the alarm again.
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a) || "android.intent.action.QUICKBOOT_POWERON".equals(a)) {
            AdalNoticeJob.again(c);
            return;
        }
        final PendingResult done = goAsync();
        new Thread(() -> {
            try { AdalNoticeJob.look(c); } catch (Exception e) { android.util.Log.w("AdalNotice", "look: " + e); }
            finally {
                schedule(c, EVERY_MS);
                done.finish();
            }
        }).start();
    }
}
