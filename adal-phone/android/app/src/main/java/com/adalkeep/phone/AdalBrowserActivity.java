package com.adalkeep.phone;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A task done on the phone itself: the portal opens here (an in-app browser,
 * so the agency's sign-in can be filled), with
 *   ✕ close · ← back · ↻ reload · 🖥/📱 desktop or phone layout · 🔑 fill the sign-in again · 📋 her details
 * The person signs in, types codes and solves captchas themselves; nothing is
 * pressed for them. The sign-in is filled only on the portal's own site.
 * Desktop layout: the whole page, pinch to zoom (turn the phone for more room).
 */
public class AdalBrowserActivity extends Activity {
    private static final String DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private WebView web;
    private ProgressBar bar;
    private TextView title;
    private ScrollView sheet;
    private Button modeBtn;
    private boolean desktop = true;
    private String mobileUa;
    private String host = "", user = "", pass = "";
    private ValueCallback<Uri[]> fileCb;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        JSONObject o;
        try { o = new JSONObject(getIntent().getStringExtra("options")); } catch (Exception e) { o = new JSONObject(); }
        host = o.optString("host", "");
        user = o.optString("user", "");
        pass = o.optString("pass", "");
        desktop = o.optBoolean("desktop", true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        // the bar on top
        LinearLayout tools = new LinearLayout(this);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        tools.setGravity(Gravity.CENTER_VERTICAL);
        tools.setBackgroundColor(Color.parseColor("#0f766e"));
        tools.setPadding(dp(4), dp(2), dp(4), dp(2));
        tools.addView(btn("✕", v -> finish()));
        tools.addView(btn("←", v -> { if (web.canGoBack()) web.goBack(); }));
        tools.addView(btn("↻", v -> web.reload()));
        modeBtn = btn(desktop ? "📱" : "🖥", v -> setDesktop(!desktop));
        tools.addView(modeBtn);
        if (!pass.isEmpty()) tools.addView(btn("🔑", v -> fill(true)));
        JSONArray fields = o.optJSONArray("fields");
        if (fields != null && fields.length() > 0) tools.addView(btn("📋", v -> sheet.setVisibility(sheet.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE)));
        title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(12);
        title.setSingleLine(true);
        title.setPadding(dp(6), 0, dp(4), 0);
        title.setText(o.optString("title", ""));
        tools.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(tools, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(46)));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        mobileUa = s.getUserAgentString();
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);   // reCAPTCHA
        applyMode();
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                title.setText(v.getTitle() != null && !v.getTitle().isEmpty() ? v.getTitle() : url);
                layout();
                fill(false);
                // pages that draw their sign-in a moment later
                v.postDelayed(() -> fill(false), 1500);
                v.postDelayed(() -> fill(false), 4000);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int p) { bar.setProgress(p); bar.setVisibility(p < 100 ? View.VISIBLE : View.INVISIBLE); }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(params.createIntent(), 41); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, length) -> {
            try {
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                r.addRequestHeader("User-Agent", ua);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, disposition, mime));
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this, "Downloading to Downloads…", Toast.LENGTH_SHORT).show();
            } catch (Exception e) { Toast.makeText(this, "Could not download", Toast.LENGTH_SHORT).show(); }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // her details: a tap types it into the field the person is on
        sheet = new ScrollView(this);
        sheet.setVisibility(View.GONE);
        sheet.setBackgroundColor(Color.parseColor("#f1f5f9"));
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(dp(8), dp(6), dp(8), dp(6));
        TextView hint = new TextView(this);
        hint.setText("Tap a box on the page, then a line here: it is typed in.");
        hint.setTextSize(11);
        list.addView(hint);
        if (fields != null) for (int i = 0; i < fields.length(); i++) {
            JSONObject f = fields.optJSONObject(i);
            if (f == null) continue;
            final String value = f.optString("value", "");
            Button b = new Button(this);
            b.setAllCaps(false);
            b.setTextSize(13);
            b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            b.setText(f.optString("label", "") + ":  " + value);
            b.setOnClickListener(v -> insert(value));
            list.addView(b);
        }
        sheet.addView(list);
        root.addView(sheet, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(230)));

        setContentView(root);
        web.loadUrl(o.optString("url", "about:blank"));
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private Button btn(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(16);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(Color.TRANSPARENT);
        b.setMinWidth(0); b.setMinimumWidth(0);
        b.setPadding(dp(10), 0, dp(10), 0);
        b.setOnClickListener(l);
        return b;
    }

    private void setDesktop(boolean d) {
        desktop = d;
        modeBtn.setText(desktop ? "📱" : "🖥");
        applyMode();
        web.reload();
        Toast.makeText(this, desktop ? "Desktop layout — pinch to zoom, turn the phone for more room" : "Phone layout", Toast.LENGTH_SHORT).show();
    }
    private void applyMode() {
        web.getSettings().setUserAgentString(desktop ? DESKTOP_UA : mobileUa);
        web.getSettings().setLoadWithOverviewMode(true);
    }
    /** Desktop: the page 1280 px wide, shown whole, zoomable. Phone: the site's own phone layout, zoom allowed. */
    private void layout() {
        String content = desktop ? "width=1280, user-scalable=yes, maximum-scale=5" : "width=device-width, initial-scale=1, user-scalable=yes, maximum-scale=5";
        web.evaluateJavascript("(function(){var m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';(document.head||document.documentElement).appendChild(m)}m.setAttribute('content'," + JSONObject.quote(content) + ")})()", null);
    }

    /** Fill the portal's sign-in (only on its own site; never presses anything). */
    private void fill(boolean force) {
        if (pass.isEmpty()) return;
        String url = web.getUrl();
        String h = url == null ? "" : Uri.parse(url).getHost();
        if (h == null || host.isEmpty() || !(h.equals(host) || h.endsWith("." + host))) {
            if (force) Toast.makeText(this, "This is not the portal's own page — nothing filled", Toast.LENGTH_SHORT).show();
            return;
        }
        String js = "(function(u,p,force){"
            + "function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'}"
            + "function put(e,v){if(!e||(!force&&e.value))return;var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');e.focus();d.set.call(e,v);"
            + "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}))}"
            + "var pw=[].filter.call(document.querySelectorAll('input[type=password]'),vis)[0];if(!pw)return 'none';"
            + "var all=[].filter.call(document.querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])'),vis);"
            + "var us=null;all.forEach(function(i){if(i.compareDocumentPosition(pw)&4)us=i});"
            + "if(u)put(us,u);put(pw,p);pw.blur();return 'filled'})(" + JSONObject.quote(user) + "," + JSONObject.quote(pass) + "," + force + ")";
        web.evaluateJavascript(js, r -> { if (force) Toast.makeText(this, "\"filled\"".equals(r) ? "Sign-in filled — press the site's Sign in" : "No sign-in box on this page", Toast.LENGTH_SHORT).show(); });
    }

    /** Type a value into the field the person is on. */
    private void insert(String value) {
        String js = "(function(v){var e=document.activeElement;if(!e||!('value' in e)){return 'none'}"
            + "var proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;"
            + "var d=Object.getOwnPropertyDescriptor(proto,'value');d.set.call(e,v);"
            + "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})(" + JSONObject.quote(value) + ")";
        web.evaluateJavascript(js, r -> { if (!"\"ok\"".equals(r)) Toast.makeText(this, "Tap a box on the page first", Toast.LENGTH_SHORT).show(); });
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == 41 && fileCb != null) { fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data)); fileCb = null; }
    }

    @Override public void onBackPressed() {
        if (sheet.getVisibility() == View.VISIBLE) sheet.setVisibility(View.GONE);
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        CookieManager.getInstance().flush();
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
