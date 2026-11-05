package com.adalkeep.phone;

import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Keeps the app running with the screen off, so the PC's calls reach this phone at once. */
public class AdalWatchService extends Service {
    static final String CHANNEL = "adal-listening";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        AdalCalls.channels(this);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Adal Keep is listening")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(open);
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        ServiceCompat.startForeground(this, 7001, b.build(), type);
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
