package com.hexadynamics.walkietalkiee;

import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            // Only trigger if this is the first press (not repeating)
            if (event.getRepeatCount() == 0) {
                JSObject data = new JSObject();
                data.put("action", "down");
                data.put("key", keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down");
                if (this.bridge != null) {
                    this.bridge.triggerJSEvent("volumeButton", "window", data.toString());
                }
            }
            return true; // Consume event
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            JSObject data = new JSObject();
            data.put("action", "up");
            data.put("key", keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down");
            if (this.bridge != null) {
                this.bridge.triggerJSEvent("volumeButton", "window", data.toString());
            }
            return true; // Consume event
        }
        return super.onKeyUp(keyCode, event);
    }
}
