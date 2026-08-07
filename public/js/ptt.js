// Push-to-Talk (PTT) Mechanism & Volume Key Listener with Pointer Capture & Lock Toggle
class PTTController {
  constructor() {
    this.isPTTActive = false;
    this.isFloorGranted = false;
    this.isBlocked = false;
    this.isToggleMode = false; // Tap once to talk, tap to stop
    this.currentChannelId = null;
    this.pttButtonEl = null;

    this.initHardwareKeyListeners();
  }

  setButtonElement(el) {
    this.pttButtonEl = el;
    this.attachTouchListeners();
  }

  setChannel(channelId) {
    this.currentChannelId = channelId;
  }

  // 1. Hardware Volume Up Button Handling
  initHardwareKeyListeners() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'AudioVolumeUp' || e.code === 'AudioVolumeUp') {
        e.preventDefault();
        e.stopPropagation();

        if (!this.isPTTActive && this.currentChannelId) {
          this.startPTT();
        }
      }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'AudioVolumeUp' || e.code === 'AudioVolumeUp') {
        e.preventDefault();
        e.stopPropagation();

        if (this.isPTTActive && !this.isToggleMode) {
          this.stopPTT();
        }
      }
    }, { capture: true });
  }

  // 2. On-Screen Touch / Pointer Listeners with setPointerCapture
  attachTouchListeners() {
    if (!this.pttButtonEl) return;

    const handleStart = (e) => {
      e.preventDefault();
      
      // Capture pointer so slight finger movement outside button doesn't interrupt transmission
      try {
        if (e.pointerId && this.pttButtonEl.setPointerCapture) {
          this.pttButtonEl.setPointerCapture(e.pointerId);
        }
      } catch (err) {
        console.warn('[PTT] Pointer capture error:', err);
      }

      if (this.isToggleMode) {
        // Toggle mode: tap to start, tap to stop
        if (this.isPTTActive) {
          this.stopPTT();
        } else if (this.currentChannelId) {
          this.startPTT();
        }
      } else {
        // Hold mode
        if (!this.isPTTActive && this.currentChannelId) {
          this.startPTT();
        }
      }
    };

    const handleEnd = (e) => {
      e.preventDefault();
      try {
        if (e.pointerId && this.pttButtonEl.releasePointerCapture) {
          this.pttButtonEl.releasePointerCapture(e.pointerId);
        }
      } catch (err) {}

      // Only stop on pointerup/pointercancel if NOT in toggle mode
      if (this.isPTTActive && !this.isToggleMode) {
        this.stopPTT();
      }
    };

    this.pttButtonEl.addEventListener('pointerdown', handleStart);
    this.pttButtonEl.addEventListener('pointerup', handleEnd);
    this.pttButtonEl.addEventListener('pointercancel', handleEnd);
    // DO NOT stop PTT on pointerleave! Finger sliding slightly outside circle should NOT cut off voice.
    this.pttButtonEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Request floor from server
  async startPTT() {
    if (this.isPTTActive || !this.currentChannelId) return;

    try {
      await window.audioEngine.requestMicPermission();
    } catch (err) {
      window.uiController.showToast('Microphone access is required to talk.', 'error');
      return;
    }

    this.isPTTActive = true;
    window.uiController.updatePTTState('requesting');
    const mimeType = window.audioEngine.getSupportedMimeType();
    window.socketManager.requestPTT(this.currentChannelId, mimeType);
  }

  // Called when server grants PTT floor
  onFloorGranted() {
    this.isFloorGranted = true;
    this.isBlocked = false;
    window.uiController.updatePTTState('transmitting');
    
    window.audioEngine.startRecording(this.currentChannelId).catch((err) => {
      console.error('[PTT] Failed to start audio recording:', err);
      this.stopPTT();
    });
  }

  // Called when server denies PTT floor
  onFloorDenied(currentSpeaker) {
    this.isPTTActive = false;
    this.isFloorGranted = false;
    this.isBlocked = true;
    window.audioEngine.playBeep('stop');
    window.uiController.updatePTTState('blocked', currentSpeaker);
    window.uiController.showToast(`Floor busy! ${currentSpeaker || 'Someone'} is talking.`, 'warning');
  }

  // Release floor
  stopPTT() {
    if (!this.isPTTActive) return;

    this.isPTTActive = false;
    if (this.isFloorGranted) {
      window.audioEngine.stopRecording();
      window.socketManager.releasePTT(this.currentChannelId);
    }
    this.isFloorGranted = false;
    this.isBlocked = false;
    window.uiController.updatePTTState('idle');
  }

  toggleMode() {
    this.isToggleMode = !this.isToggleMode;
    if (this.isPTTActive) {
      this.stopPTT();
    }
    return this.isToggleMode;
  }
}

window.pttController = new PTTController();
