package com.adalkeep.phone;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import org.json.JSONArray;

/**
 * A run's call as a normal Android notification: the number is typed right in
 * it (a captcha shows its picture), a question has its answers as buttons, and
 * a tap opens Adal Keep. ReplyReceiver hands what was typed to the page.
 */
final class AdalCalls {
    static final String CHANNEL = "adal-calls";
    static final String TEXT = "text";

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager m = c.getSystemService(NotificationManager.class);
        m.createNotificationChannel(new NotificationChannel(CHANNEL, "Needs you", NotificationManager.IMPORTANCE_HIGH));
        NotificationChannel quiet = new NotificationChannel(AdalWatchService.CHANNEL, "Adal Keep is listening", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        m.createNotificationChannel(quiet);
    }

    private static int mutable() { return Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0; }

    private static PendingIntent reply(Context c, int run, int slot, String text) {
        Intent i = new Intent(c, ReplyReceiver.class).putExtra("run", run);
        if (text != null) i.putExtra("choice", text);
        return PendingIntent.getBroadcast(c, run * 8 + slot, i, PendingIntent.FLAG_UPDATE_CURRENT | mutable());
    }

    static void show(Context c, int run, String title, String body, String image, boolean asks, String label, JSONArray choices) {
        channels(c);
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(c, run, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        if (image != null && image.contains(",")) {
            byte[] raw = Base64.decode(image.substring(image.indexOf(',') + 1), Base64.DEFAULT);
            Bitmap pic = BitmapFactory.decodeByteArray(raw, 0, raw.length);
            if (pic != null) b.setLargeIcon(pic).setStyle(new NotificationCompat.BigPictureStyle().bigPicture(pic).bigLargeIcon((Bitmap) null));
        }
        if (choices != null && choices.length() > 0) {
            for (int i = 0; i < Math.min(3, choices.length()); i++) {
                String t = choices.optString(i);
                b.addAction(new NotificationCompat.Action.Builder(0, t, reply(c, run, i + 1, t)).build());
            }
        } else if (asks) {
            RemoteInput input = new RemoteInput.Builder(TEXT).setLabel(label == null ? "Numbers" : label).build();
            b.addAction(new NotificationCompat.Action.Builder(0, "Answer", reply(c, run, 0, null)).addRemoteInput(input).build());
        }
        try { NotificationManagerCompat.from(c).notify(run, b.build()); } catch (SecurityException e) { /* notifications are off */ }
    }

    static void cancel(Context c, int run) { NotificationManagerCompat.from(c).cancel(run); }
}
