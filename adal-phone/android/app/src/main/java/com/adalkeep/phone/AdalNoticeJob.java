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
        if (!on) { js.cancel(SOON); js.cancel(EVERY); AdalNoticeAlarm.cancel(c); return; }
        again(c);
    }

    /** The job and the alarm (again): at pairing, at every start of the app, after a restart of the phone. */
    static void again(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        ComponentName me = new ComponentName(c, AdalNoticeJob.class);
        js.schedule(new JobInfo.Builder(EVERY, me).setPeriodic(15 * 60000L).setPersisted(true)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());
        soon(c, 5000);
        // Android's alarm too: it also wakes the app after it was swiped away.
        AdalNoticeAlarm.schedule(c, 30_000L);
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
            // (A phone that dropped the alarm when the app was swiped away gets it back here.)
            if (getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false)) AdalNoticeAlarm.schedule(getApplicationContext(), 60_000L);
            if (getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false)) soon(getApplicationContext(), 60000);
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return true; }

    /** One look at the bell: new ones shown, gone ones taken away. */
    static synchronized void look(Context c) throws Exception {
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
        java.util.List<JSONObject> fresh = new java.util.ArrayList<>();
        Set<String> titles = new HashSet<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject n = list.optJSONObject(i);
            if (n == null) continue;
            long id = n.optLong("id", 0);
            if (id <= 0) continue;
            now.add(String.valueOf(id));
            newest = Math.max(newest, id);
            // The first look only remembers where the bell is (nothing old pops up).
            if (last < 0 || id <= last) continue;
            // Not the same words twice in one look, nothing older than a day.
            if (!titles.add(n.optString("title", ""))) continue;
            if (ageMs(n.optString("created_at", "")) > 24 * 3600_000L) continue;
            fresh.add(n);
        }
        // Adal Keep on the screen: its own bell shows them (no Android notification on top).
        if (!MainActivity.inFront) {
            // A pile (the phone was off a while): the newest one, and how many more.
            fresh.sort((a, b) -> Long.compare(b.optLong("id"), a.optLong("id")));
            for (int i = 0; i < Math.min(2, fresh.size()); i++) {
                JSONObject n = fresh.get(i);
                String title = n.optString("title", "Adal Keep");
                if (i == 1 && fresh.size() > 2) title = "+" + (fresh.size() - 1) + " more — " + title;
                show(c, (int) n.optLong("id"), title, n.optString("body", n.optString("message", "")));
                shown.add(String.valueOf(n.optLong("id")));
            }
        }
        try { calls(c, p, url, anon, agency, token); } catch (Exception ignored) { }
        // Cleared on Adal Keep: away from the phone too.
        for (String s : new HashSet<>(shown)) if (!now.contains(s)) { NotificationManagerCompat.from(c).cancel(BASE + Integer.parseInt(s)); shown.remove(s); }
        p.edit().putLong("last", newest).putStringSet("shown", shown).apply();
    }

    /** How long ago ("2026-11-18 10:09:35", UTC, or an ISO time); 0 when unknown. */
    static long ageMs(String when) {
        try {
            String t = when.trim().replace(' ', 'T');
            if (t.length() < 19) return 0;
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            long ms = f.parse(t.substring(0, 19)).getTime();
            // An offset at the end (+03:00 / +0300): back to UTC.
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("([+-])(\\d\\d):?(\\d\\d)$").matcher(t.substring(19));
            if (m.find()) ms -= ("-".equals(m.group(1)) ? -1 : 1) * (Integer.parseInt(m.group(2)) * 3600_000L + Integer.parseInt(m.group(3)) * 60_000L);
            return System.currentTimeMillis() - ms;
        } catch (Exception e) { return 0; }
    }

    /**
     * What needs a person now (a sign-in, a code, a reCAPTCHA, a Save …), from
     * the online copy the PC keeps ("/automations/attention"): each new one is a
     * notification, also with Adal Keep closed; gone from the PC, gone here. One
     * a call — the app's own notice of the same call (notifyCall) counts too.
     */
    static synchronized void calls(Context c, SharedPreferences p, String url, String anon, String agency, String token) throws Exception {
        String q = url + "/rest/v1/keep_meta?select=key,data,updated_at&agency_id=eq." + URLEncoder.encode(agency, "UTF-8") + "&key=in.(%22%2Fautomations%2Fattention%22,%22%2F_pc%22)";
        JSONArray rows = new JSONArray(http("GET", q, anon, token, null));
        JSONArray list = null;
        String beat = "";
        for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.getJSONObject(i);
            if ("/automations/attention".equals(r.optString("key"))) list = r.optJSONArray("data");
            else beat = r.optString("updated_at", "");
        }
        if (list == null) return;
        // The PC's heartbeat (every 15 s) is older than 3 minutes: the PC is off — nothing is calling now.
        if (beat.length() > 0 && ageMs(beat) > 3 * 60_000L) list = new JSONArray();
        boolean first = !p.getBoolean("calls_seen", false);
        Set<String> had = new HashSet<>(p.getStringSet("calls", new HashSet<>()));
        Set<String> keep = new HashSet<>();
        Set<Integer> runs = new HashSet<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject n = list.optJSONObject(i);
            if (n == null) continue;
            int run = n.optInt("run_id", 0);
            if (run <= 0 || n.optLong("phone_wait_ms", 0) > 0) continue;
            String key = run + ":" + n.optString("title", "");
            keep.add(key); runs.add(run);
            if (first || had.contains(key) || MainActivity.inFront) continue;
            // Only fresh calls (made in the last 2 hours).
            long at = n.optLong("at", 0);
            if (at > 0 && System.currentTimeMillis() - at > 2 * 3600_000L) continue;
            AdalCalls.show(c, run, n.optString("full_name", "Adal Keep"), n.optString("title", "Needs you"), null, false, null, null);
        }
        // Gone on the PC: away from the phone too.
        for (String k : had) {
            try { int run = Integer.parseInt(k.split(":")[0]); if (!runs.contains(run)) AdalCalls.cancel(c, run); } catch (Exception ignored) { }
        }
        if (MainActivity.inFront) keep.addAll(had);
        p.edit().putBoolean("calls_seen", true).putStringSet("calls", keep).apply();
    }

    /** The app showed this call itself: the background look does not show it again. */
    static void calledHere(Context c, int run, String title) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> had = new HashSet<>(p.getStringSet("calls", new HashSet<>()));
        had.add(run + ":" + title);
        p.edit().putStringSet("calls", had).apply();
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
