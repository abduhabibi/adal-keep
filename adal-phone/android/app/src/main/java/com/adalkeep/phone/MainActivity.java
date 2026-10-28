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

    private void exitOrWarn() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) { finish(); return; }
        lastBack = now;
        Toast.makeText(this, "Press back again to leave Adal Keep", Toast.LENGTH_SHORT).show();
    }
}
