package com.adalkeep.phone;

import android.os.Bundle;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private long lastBack = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AdalDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
        // The page sits between the status bar and the gesture bar (Android 15);
        // those two bands are dark, so the clock, wifi and battery show white on them.
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0xFF111117));
        getWindow().getDecorView().setBackgroundColor(0xFF111117);
        androidx.core.view.WindowInsetsControllerCompat bars = androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);

        // The keyboard: the page ends at its top edge (Android 15 lays the
        // keyboard over the page otherwise), so a box being typed in — the
        // chat's message box — stays in sight just above it.
        WebView page = getBridge() != null ? getBridge().getWebView() : null;
        if (page != null) {
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(page, (v, insets) -> {
                androidx.core.graphics.Insets sys = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                androidx.core.graphics.Insets ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime());
                android.view.ViewGroup.MarginLayoutParams m = (android.view.ViewGroup.MarginLayoutParams) v.getLayoutParams();
                m.leftMargin = sys.left;
                m.rightMargin = sys.right;
                m.topMargin = sys.top;
                m.bottomMargin = Math.max(sys.bottom, ime.bottom);
                v.setLayoutParams(m);
                return androidx.core.view.WindowInsetsCompat.CONSUMED;
            });
            androidx.core.view.ViewCompat.requestApplyInsets(page);
        }

        // Back: the page goes back (or its full-screen view closes);
        // at the first page, back twice within 2 seconds leaves the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) { exitOrWarn(); return; }
                web.evaluateJavascript("(window.__adalBack ? window.__adalBack() : false)", (handled) -> {
                    if ("true".equals(handled)) return;
                    exitOrWarn();
                });
            }
        });
    }

    // Out of sight the page keeps running (AdalWatchService keeps the app alive):
    // it is what hears the PC's calls and shows them as notifications.
    private void keepPageRunning() {
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web == null) return;
        web.onResume();
        web.resumeTimers();
    }

    @Override
    public void onPause() {
        super.onPause();
        keepPageRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepPageRunning();
    }

    private void exitOrWarn() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) { finish(); return; }
        lastBack = now;
        Toast.makeText(this, "Press back again to leave Adal Keep", Toast.LENGTH_SHORT).show();
    }
}
