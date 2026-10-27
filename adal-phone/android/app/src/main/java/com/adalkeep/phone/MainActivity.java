package com.adalkeep.phone;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AdalDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
