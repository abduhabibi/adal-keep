package com.adalkeep.phone;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Finds Adal Keep PCs on this Wi-Fi: the same UDP question Adal Keep PCs ask
 * (backend/src/services/discovery.js):
 *   request  "ADAL_KEEP_DISCOVER_V1"                to port 45454 (broadcast)
 *   response "ADAL_KEEP_SERVER_V1|<port>|<ip>|<name>"
 * find({timeoutMs}) → { servers: [{ url, name }] }
 */
@CapacitorPlugin(name = "AdalDiscovery")
public class AdalDiscoveryPlugin extends Plugin {
    private static final int PORT = 45454;

    @PluginMethod
    public void find(final PluginCall call) {
        final int timeoutMs = call.getInt("timeoutMs", 2500);
        new Thread(() -> {
            JSArray servers = new JSArray();
            Set<String> seen = new LinkedHashSet<>();
            WifiManager.MulticastLock lock = null;
            try (DatagramSocket socket = new DatagramSocket()) {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    lock = wifi.createMulticastLock("adal-discovery");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }
                socket.setBroadcast(true);
                socket.setSoTimeout(300);
                byte[] ask = "ADAL_KEEP_DISCOVER_V1".getBytes(StandardCharsets.UTF_8);
                Set<InetAddress> targets = new LinkedHashSet<>();
                targets.add(InetAddress.getByName("255.255.255.255"));
                InetAddress subnet = subnetBroadcast(wifi);
                if (subnet != null) targets.add(subnet);

                long end = System.currentTimeMillis() + timeoutMs;
                long nextAsk = 0;
                byte[] buf = new byte[512];
                while (System.currentTimeMillis() < end) {
                    if (System.currentTimeMillis() >= nextAsk) {
                        for (InetAddress t : targets) {
                            try { socket.send(new DatagramPacket(ask, ask.length, t, PORT)); } catch (Exception ignored) {}
                        }
                        nextAsk = System.currentTimeMillis() + 800;
                    }
                    try {
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        socket.receive(p);
                        String msg = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8).trim();
                        String[] parts = msg.split("\\|");
                        if (parts.length < 2 || !"ADAL_KEEP_SERVER_V1".equals(parts[0])) continue;
                        String port = parts[1];
                        // The address the answer came from is the one this phone can reach.
                        String ip = p.getAddress().getHostAddress();
                        String url = "http://" + ip + ":" + port;
                        if (seen.add(url)) {
                            JSObject s = new JSObject();
                            s.put("url", url);
                            s.put("name", parts.length > 3 ? parts[3] : "Adal Keep");
                            servers.put(s);
                        }
                    } catch (SocketTimeoutException ignored) {
                    }
                }
            } catch (Exception e) {
                // No Wi-Fi or no socket: nothing found.
            } finally {
                if (lock != null && lock.isHeld()) lock.release();
            }
            JSObject ret = new JSObject();
            ret.put("servers", servers);
            call.resolve(ret);
        }).start();
    }

    /** This app's own version: { versionCode, versionName }. */
    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject r = new JSObject();
            r.put("versionCode", Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode);
            r.put("versionName", pi.versionName);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * Update this app: download the newer APK from the PC and open Android's
     * installer ("Update?"). The first time, Android asks to allow installing
     * apps from Adal Keep. installUpdate({url}) → { started: true }
     */
    @PluginMethod
    public void installUpdate(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("no url"); return; }
        new Thread(() -> {
            try {
                Context ctx = getContext();
                if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
                    Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
                    allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(allow);
                    JSObject r = new JSObject();
                    r.put("started", false);
                    r.put("needsPermission", true);
                    call.resolve(r);
                    return;
                }
                File dir = new File(ctx.getExternalCacheDir(), "updates");
                dir.mkdirs();
                File apk = new File(dir, "adal-keep.apk");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(60000);
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(install);
                JSObject r = new JSObject();
                r.put("started", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    private static InetAddress subnetBroadcast(WifiManager wifi) {
        try {
            if (wifi == null) return null;
            DhcpInfo d = wifi.getDhcpInfo();
            if (d == null || d.ipAddress == 0) return null;
            int mask = d.netmask != 0 ? d.netmask : 0x00FFFFFF;
            int bc = (d.ipAddress & mask) | ~mask;
            byte[] q = new byte[4];
            for (int k = 0; k < 4; k++) q[k] = (byte) ((bc >> (k * 8)) & 0xFF);
            return InetAddress.getByAddress(q);
        } catch (Exception e) {
            return null;
        }
    }
}
