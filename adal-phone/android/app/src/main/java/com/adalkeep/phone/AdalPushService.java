package com.adalkeep.phone;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Instant "needs you" (Firebase Cloud Messaging, asked on 2026-11-19): the main
 * PC sends a push with no words in it the moment a call is online; this wakes
 * the app — also after it was swiped away — and one look at the online copy
 * (AdalNoticeJob.look) shows the call. The job's own look every minute stays
 * as the fallback (no google-services.json in the build, no Google Play
 * services, a push lost).
 */
public class AdalPushService extends FirebaseMessagingService {
    static final String TOKEN = "fcm_token";

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        android.util.Log.i("AdalNotice", "push: " + msg.getData());
        Context c = getApplicationContext();
        // (Already on a background thread of Firebase's: the look may take a few seconds.)
        try { AdalNoticeJob.look(c); } catch (Exception e) { android.util.Log.w("AdalNotice", "push look: " + e); }
    }

    @Override
    public void onNewToken(String token) {
        // The page hands it to the main PC at its next start (AdalDiscovery.pushToken).
        getApplicationContext().getSharedPreferences(AdalNoticeJob.PREFS, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply();
        android.util.Log.i("AdalNotice", "push: new token");
    }

    /** This phone's push token, or "" (a build without Firebase, no Google Play services). */
    interface Got { void token(String t); }
    static void token(Context c, Got got) {
        SharedPreferences p = c.getSharedPreferences(AdalNoticeJob.PREFS, Context.MODE_PRIVATE);
        try {
            if (com.google.firebase.FirebaseApp.getApps(c).isEmpty()) { got.token(""); return; }
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
                String s = t.isSuccessful() && t.getResult() != null ? t.getResult() : p.getString(TOKEN, "");
                if (!s.isEmpty()) p.edit().putString(TOKEN, s).apply();
                got.token(s);
            });
        } catch (Throwable e) {
            android.util.Log.w("AdalNotice", "push: " + e);
            got.token(p.getString(TOKEN, ""));
        }
    }
}
