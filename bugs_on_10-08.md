# Robofest 2.0 Walkie-Talkie — Bug Fix Report (10-08-2026)

This document details the analysis and resolution of critical runtime bugs identified and fixed in the Robofest 2.0 Walkie-Talkie PWA application on August 10, 2026.

---

## 1. Typo in Emergency Floor Cleanup (`public/js/app.js`)
* **Type**: Reference/Typo Bug
* **Status**: **Fixed** (Commit: `c0e525a`)
* **Details**:
  * In the main application's socket handler for `ptt:released`, the system attempted to clean up dynamic WebRTC streams for global emergency/broadcasts by invoking `window.webrtcManager.closeEmergencyPeer(data.socketId)`.
  * Following the refactoring of `webrtc.js` to a unified warm/dynamic engine, this method was renamed to `closeDynamicPeer()`. The old reference caused a client-side JavaScript crash when an emergency floor holder released the mic.
* **Fix**:
  * Updated the method call to `window.webrtcManager.closeDynamicPeer(data.socketId)` to align with the new unified manager signature.

---

## 2. Microphone Request Async Race Condition (`public/js/audio.js`)
* **Type**: Async Race Condition
* **Status**: **Fixed** (Commit: `c0e525a`)
* **Details**:
  * Requesting the microphone via `navigator.mediaDevices.getUserMedia` is asynchronous and requires user permission or check.
  * During page setup, early mic requests occurred concurrently with login form actions. If another method requested the stream before the first one resolved, it initiated a duplicate call to `getUserMedia`.
  * On mobile operating systems (Android/iOS Safari), calling `getUserMedia` concurrently while another request is pending throws a `NotAllowedError` or `DeviceInUse` exception, locking the user out of the mic.
* **Fix**:
  * Cached the request promise as `this.micPromise`.
  * Subsequent calls now await the active promise instead of starting a new hardware request, guaranteeing only one system call runs at a time.

---

## 3. Web Audio Pipeline Setup Race Condition (`public/js/webrtc.js`)
* **Type**: Async Race Condition
* **Status**: **Fixed** (Commit: `c0e525a`)
* **Details**:
  * With the introduction of Web Audio API Gain Nodes to prevent microphone leakage, the manager calls `ensureLocalStream()` before initiating peer connections.
  * During rapid member syncing, concurrent connection requests initiated concurrent runs of `ensureLocalStream()`.
  * This caused overlapping setups of `AudioContext`, `createMediaStreamSource`, and node routing connections, occasionally leading to disconnect/reconnect conflicts in the audio routing graph.
* **Fix**:
  * Implemented `this.localStreamPromise` cache to synchronize and wrap Web Audio routing setup.

---

## 4. Volume change bypass state change race (`public/js/ptt.js`)
* **Type**: Timing / Race Condition
* **Status**: **Fixed** (Commit: `c0e525a`)
* **Details**:
  * The physical volume key listener listens to `volumechange` events on a silent background audio element.
  * To prevent JS volume resets from triggering a double-fire, a boolean flag `_volChangingByJS` was used and reset using `requestAnimationFrame`.
  * On low-performance mobile devices, the browser sometimes dispatched the `volumechange` event in a task queue *after* the animation frame callback cleared the flag. This caused the app to mistake a JS volume restore for a new physical button press, causing an immediate double-trigger of PTT.
* **Fix**:
  * Removed timer-based flag resets.
  * The flag `_volChangingByJS` is now cleared synchronously inside the event handler itself, guaranteeing a 1:1 match of JS changes to ignore events.

---

## 5. Screen Wake Lock Loss on Backgrounding (`public/js/ui.js`)
* **Type**: Battery / Sleep Bug
* **Status**: **Fixed** (Commit: `c0e525a`)
* **Details**:
  * Screen Wake Locks prevent mobile devices from sleeping during the event.
  * By W3C specification, wake locks are automatically released by the browser whenever the PWA goes to the background (e.g. user toggles screen, checks notifications).
  * Returning to the app left the lock inactive, letting the device sleep.
* **Fix**:
  * Added a `visibilitychange` listener.
  * The app automatically re-requests the Screen Wake Lock whenever the document state changes to `'visible'`.

---

## 6. Premature Connection Teardown on ICE handover (`public/js/webrtc.js`)
* **Type**: Network / Handover Bug
* **Status**: **Fixed** (Commit: `c0e525a`)
* **Details**:
  * The ICE connection state listener closed peer connections when state shifted to `'failed'` or `'disconnected'`.
  * In large arenas, moving between Wi-Fi access points or switching from Wi-Fi to mobile data momentarily triggers `'disconnected'` before WebRTC resolves a new network path.
  * Tearing it down immediately caused dropouts instead of allowing WebRTC's ICE agent to auto-recover when changing access points.
* **Fix**:
  * Removed `'disconnected'` from the teardown condition. The peer is now only closed on `'failed'`, preserving connections during mobile handovers.
