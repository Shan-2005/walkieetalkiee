// Push-to-Talk (PTT) Mechanism — Desktop keys + Mobile Volume Button Detection
class PTTController {
  constructor() {
    this.isPTTActive = false;
    this.isFloorGranted = false;
    this.isBlocked = false;
    this.isToggleMode = false; // Tap once to talk, tap to stop
    this.currentChannelId = null;
    this.pttButtonEl = null;

    // Mobile volume button detection state
    this._volProbeAudio = null;
    this._volBaseline = 0.5;
    this._volDebounce = null;
    this._volReady = false;

    this.initHardwareKeyListeners();
    this.initMobileVolumeDetection();
  }

  setButtonElement(el) {
    this.pttButtonEl = el;
    this.attachTouchListeners();
  }

  setChannel(channelId) {
    this.currentChannelId = channelId;
  }

  isVolumeUpKey(e) {
    const k = (e.key || '').toLowerCase();
    const c = (e.code || '').toLowerCase();
    return k === 'audiovolumeup' || k === 'volumeup' || c === 'audiovolumeup' || c === 'volumeup' || e.keyCode === 24 || e.which === 24;
  }

  // 1. Desktop Hardware Volume Up / Keyboard Key Handling
  initHardwareKeyListeners() {
    window.addEventListener('keydown', (e) => {
      if (this.isVolumeUpKey(e)) {
        e.preventDefault();
        e.stopPropagation();

        if (!this.isPTTActive && this.currentChannelId) {
          this.startPTT();
        }
      }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
      if (this.isVolumeUpKey(e)) {
        e.preventDefault();
        e.stopPropagation();

        if (this.isPTTActive && !this.isToggleMode) {
          this.stopPTT();
        }
      }
    }, { capture: true });
  }

  // 2. Mobile Volume Button Detection via hidden audio element
  //    Mobile browsers block keydown for volume keys, but they DO fire
  //    'volumechange' events on <audio> elements when system volume changes.
  //    We use this to detect volume button presses as a PTT toggle trigger.
  initMobileVolumeDetection() {
    // Only activate on touch devices (phones/tablets)
    if (!('ontouchstart' in window)) return;

    try {
      // Create a silent audio element that keeps the media audio session alive
      const audio = document.createElement('audio');
      audio.id = 'vol-probe-audio';
      audio.loop = true;
      audio.playsInline = true;
      audio.style.display = 'none';

      // Generate a tiny silent WAV file as a data URI (44 bytes of silence)
      // This keeps the audio session alive so volumechange fires
      const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGFwYQAAAAA=';
      audio.src = silentWav;

      document.body.appendChild(audio);
      this._volProbeAudio = audio;

      // Listen for volume changes
      audio.addEventListener('volumechange', () => {
        if (!this._volReady) return;
        if (!this.currentChannelId) return;

        // Debounce rapid volume change events (holding button sends many)
        clearTimeout(this._volDebounce);
        this._volDebounce = setTimeout(() => {
          // Toggle PTT on each volume button press
          if (this.isPTTActive) {
            this.stopPTT();
            window.uiController.showToast('🔇 Mic OFF (Volume key)', 'info');
          } else {
            this.startPTT();
            window.uiController.showToast('🎙️ Mic ON (Volume key)', 'info');
          }
        }, 150); // 150ms debounce to catch rapid repeat events
      });

      console.log('[PTT] Mobile volume detection initialized (touch device detected).');
    } catch (err) {
      console.warn('[PTT] Mobile volume detection setup failed:', err);
    }
  }

  // Must be called on a user gesture (e.g. login button click) to start the probe audio
  activateVolumeProbe() {
    if (!this._volProbeAudio) return;
    const audio = this._volProbeAudio;
    audio.volume = this._volBaseline;
    audio.play().then(() => {
      this._volReady = true;
      console.log('[PTT] Volume probe audio playing — hardware volume buttons active!');
    }).catch((err) => {
      console.warn('[PTT] Volume probe audio play failed (needs user gesture):', err);
    });
  }

  // 3. On-Screen Touch / Pointer Listeners with setPointerCapture
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
    if (this.isPTTActive || this.isBlocked || !this.currentChannelId) return;

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

  // Called when someone else starts speaking in the channel
  onFloorActive() {
    this.isBlocked = true;
  }

  // Called when the active speaker releases the floor
  onFloorReleased() {
    this.isBlocked = false;
    this.isFloorGranted = false;
    this.isPTTActive = false;
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

  setToggleMode(enabled) {
    this.isToggleMode = !!enabled;
    if (this.isPTTActive) {
      this.stopPTT();
    }
    console.log('[PTT] Toggle Mode changed to:', this.isToggleMode);
  }
}

window.pttController = new PTTController();
