package com.adalkeep.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * LMIS's sign-in codes (an SMS) go to the agency's Adal Keep by themselves
 * (asked on 2026-11-13): only when "Send LMIS codes to Adal Keep" is on in
 * this phone's Settings, and only a message from LMIS (or naming it) with a
 * code in it — any other SMS is never read further, kept or sent. The code
 * goes through the agency's online link (Supabase keep_calls) to the main PC,
 * whose LMIS robot types it in. Works with the app closed.
 */
public class SmsCodeReceiver extends BroadcastReceiver {
    static final String PREFS = "adal-sms";
    private static final Pattern LMIS = Pattern.compile("(?i)lmis|labou?r market|e-?lmis|molsa|mols\\b|ministry of labou?r");
    private static final Pattern CODE = Pattern.compile("(?<![0-9])([0-9]{4,8})(?![0-9])");

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("on", false)) return;
        StringBuilder body = new StringBuilder();
        String from = "";
        for (SmsMessage m : Telephony.Sms.Intents.getMessagesFromIntent(intent)) {
            if (m == null) continue;
            if (from.isEmpty() && m.getOriginatingAddress() != null) from = m.getOriginatingAddress();
            body.append(m.getMessageBody());
        }
        String text = body.toString();
        if (!(LMIS.matcher(from).find() || LMIS.matcher(text).find())) return;   // not LMIS: left alone
        Matcher c = CODE.matcher(text);
        if (!c.find()) return;
        final String code = c.group(1);
        final String sender = from;
        final PendingResult done = goAsync();
        new Thread(() -> {
            try { send(p, code, sender); } catch (Exception ignored) { } finally { done.finish(); }
        }).start();
    }

    /** The code to the main PC: this phone's online account, then a call the PC answers. */
    static void send(SharedPreferences p, String code, String from) throws Exception {
        String url = p.getString("url", ""), anon = p.getString("anon", ""), agency = p.getString("agency", "");
        String email = p.getString("email", ""), password = p.getString("password", "");
        if (url.isEmpty() || anon.isEmpty() || agency.isEmpty() || email.isEmpty() || password.isEmpty()) return;
        JSONObject cred = new JSONObject();
        cred.put("email", email);
        cred.put("password", password);
        JSONObject s = new JSONObject(post(url + "/auth/v1/token?grant_type=password", anon, null, cred.toString()));
        String token = s.optString("access_token", "");
        if (token.isEmpty()) return;
        JSONObject body = new JSONObject();
        body.put("code", code);
        body.put("from", from == null ? "" : from);
        body.put("at", System.currentTimeMillis());
        JSONObject call = new JSONObject();
        call.put("agency_id", agency);
        call.put("method", "POST");
        call.put("path", "/lmis/sms-code");
        call.put("body", body);
        post(url + "/rest/v1/keep_calls", anon, token, call.toString());
    }

    private static String post(String address, String anon, String token, String json) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(address).openConnection();
        h.setRequestMethod("POST");
        h.setConnectTimeout(15000);
        h.setReadTimeout(20000);
        h.setDoOutput(true);
        h.setRequestProperty("apikey", anon);
        h.setRequestProperty("Content-Type", "application/json");
        h.setRequestProperty("Prefer", "return=minimal");
        if (token != null) h.setRequestProperty("Authorization", "Bearer " + token);
        try (OutputStream o = h.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
        int status = h.getResponseCode();
        InputStream in = status < 400 ? h.getInputStream() : h.getErrorStream();
        String out = "";
        if (in != null) {
            java.io.ByteArrayOutputStream all = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) all.write(buf, 0, n);
            in.close();
            out = new String(all.toByteArray(), StandardCharsets.UTF_8);
        }
        h.disconnect();
        if (status >= 400) throw new Exception("HTTP " + status);
        return out.isEmpty() ? "{}" : out;
    }
}
