package com.adalkeep.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.RemoteInput;

/** What was typed or chosen in a notification goes to the page, which sends it to the PC. */
public class ReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        int run = i.getIntExtra("run", 0);
        String text = i.getStringExtra("choice");
        Bundle typed = RemoteInput.getResultsFromIntent(i);
        if (text == null && typed != null && typed.getCharSequence(AdalCalls.TEXT) != null) text = typed.getCharSequence(AdalCalls.TEXT).toString();
        AdalCalls.cancel(c, run);
        if (text == null) return;
        if (!AdalDiscoveryPlugin.reply(run, text)) {
            // The app is closed: it opens, and the question is still in its notification.
            c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }
}
