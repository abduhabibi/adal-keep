package com.adalkeep.phone;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Adal Keep's notifications (the bell) as real Android notifications, also
 * when the app is closed (asked on 2026-11-15). Android runs this job about
 * every minute while the phone is awake (each run asks for the next) and at
 * least every 15 minutes otherwise, also after a restart: it reads the
 * agency's online copy of the bell ("/notifications", the PC keeps it) with
 * this phone's own online account and shows each new one. No lasting
 * notification, no service kept running. Cleared on Adal Keep (anywhere):
 * gone from the phone too.
 */
public class AdalNoticeJob extends JobService {
    static final String PREFS = "adal-notices";
    static final String CHANNEL = "adal-notices";
    private static final int SOON = 7101, EVERY = 7102;
    private static final int BASE = 300000;   // notification ids: BASE + the bell's id

    /** Keep the online account for the job and start it (or stop it: on=false). */
    static void setUp(Context c, boolean on, String url, String anon, String email, String password, String agency) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor e = p.edit().putBoolean("on", on);
        if (on) {
            if (!url.equals(p.getString("url", "")) || !agency.equals(p.getString("agency", ""))) e.remove("last").remove("token").remove("shown");
            e.putString("url", url).putString("anon", anon).putString("email", email).putString("password", password).putString("agency", agency);
        } else {
            for (String k : new String[] { "url", "anon", "email", "password", "agency", "token", "shown" }) e.remove(k);
        }
        e.apply();
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (!on) { js.cancel(SOON); js.cancel(EVERY); return; }
        ComponentName me = new ComponentName(c, AdalNoticeJob.class);
        js.schedule(new JobInfo.Builder(EVERY, me).setPeriodic(15 * 60000L).setPersisted(true)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());
        soon(c, 5000);
    }

    private static void soon(Context c, long ms) {
        try {
            c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(SOON, new ComponentName(c, AdalNoticeJob.class))
                .setMinimumLatency(ms).setOverrideDeadline(ms + 4 * 60000L).setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(() -> {
            try { look(getApplicationContext()); } catch (Exception ignored) { }
            if (getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false)) soon(getApplicationContext(), 60000);
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return true; }

    /** One look at the bell: new ones shown, gone ones taken away. */
    static void look(Context c) throws Exception {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("on", false)) return;
        String url = p.getString("url", ""), anon = p.getString("anon", ""), agency = p.getString("agency", "");
        if (url.isEmpty() || anon.isEmpty() || agency.isEmpty()) return;
        String token = token(p, url, anon);
        if (token == null) return;
        String q = url + "/rest/v1/keep_meta?select=data&agency_id=eq." + URLEncoder.encode(agency, "UTF-8") + "&key=eq." + URLEncoder.encode("/notifications", "UTF-8");
        JSONArray rows = new JSONArray(http("GET", q, anon, token, null));
        if (rows.length() == 0) return;
        JSONArray list = rows.getJSONObject(0).optJSONArray("data");
        if (list == null) return;
        long last = p.getLong("last", -1);
        Set<String> shown = new HashSet<>(p.getStringSet("shown", new HashSet<>()));
        Set<String> now = new HashSet<>();
        long newest = last;
        for (int i = 0; i < list.length(); i++) {
            JSONObject n = list.optJSONObject(i);
            if (n == null) continue;
            long id = n.optLong("id", 0);
            if (id <= 0) continue;
            now.add(String.valueOf(id));
            newest = Math.max(newest, id);
            // The first look only remembers where the bell is (nothing old pops up).
            if (last < 0 || id <= last) continue;
            show(c, (int) id, n.optString("title", "Adal Keep"), n.optString("body", n.optString("message", "")));
            shown.add(String.valueOf(id));
        }
        // Cleared on Adal Keep: away from the phone too.
        for (String s : new HashSet<>(shown)) if (!now.contains(s)) { NotificationManagerCompat.from(c).cancel(BASE + Integer.parseInt(s)); shown.remove(s); }
        p.edit().putLong("last", newest).putStringSet("shown", shown).apply();
    }

    static void clear(Context c, boolean all, int id) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> shown = new HashSet<>(p.getStringSet("shown", new HashSet<>()));
        for (String s : new HashSet<>(shown)) {
            if (all || s.equals(String.valueOf(id))) { NotificationManagerCompat.from(c).cancel(BASE + Integer.parseInt(s)); shown.remove(s); }
        }
        p.edit().putStringSet("shown", shown).apply();
    }

    private static void show(Context c, int id, String title, String body) {
        if (Build.VERSION.SDK_INT >= 26) {
            c.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_HIGH));
        }
        // The body's last line may be a link (a WhatsApp chat): shown as text, the tap opens Adal Keep's bell.
        String text = body.replaceAll("\\s*https?://\\S+\\s*$", "").trim();
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK)
            .setData(Uri.parse("adalkeep://notifications"));
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(c, BASE + id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        try { NotificationManagerCompat.from(c).notify(BASE + id, b.build()); } catch (SecurityException e) { /* notifications are off */ }
    }

    /** This phone's online sign-in, kept until it runs out. */
    private static String token(SharedPreferences p, String url, String anon) throws Exception {
        String t = p.getString("token", "");
        if (!t.isEmpty() && p.getLong("token_until", 0) > System.currentTimeMillis()) return t;
        JSONObject cred = new JSONObject();
        cred.put("email", p.getString("email", ""));
        cred.put("password", p.getString("password", ""));
        JSONObject s = new JSONObject(http("POST", url + "/auth/v1/token?grant_type=password", anon, null, cred.toString()));
        t = s.optString("access_token", "");
        if (t.isEmpty()) return null;
        p.edit().putString("token", t).putLong("token_until", System.currentTimeMillis() + (s.optLong("expires_in", 3600) - 120) * 1000L).apply();
        return t;
    }

    private static String http(String method, String address, String anon, String token, String json) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(address).openConnection();
        h.setRequestMethod(method);
        h.setConnectTimeout(15000);
        h.setReadTimeout(20000);
        h.setRequestProperty("apikey", anon);
        if (token != null) h.setRequestProperty("Authorization", "Bearer " + token);
        if (json != null) {
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = h.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
        }
        int status = h.getResponseCode();
        InputStream in = status < 400 ? h.getInputStream() : h.getErrorStream();
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        if (in != null) { byte[] buf = new byte[8192]; for (int n; (n = in.read(buf)) > 0; ) all.write(buf, 0, n); in.close(); }
        h.disconnect();
        if (status >= 400) throw new Exception("HTTP " + status);
        String out = new String(all.toByteArray(), StandardCharsets.UTF_8);
        return out.isEmpty() ? "[]" : out;
    }
}
