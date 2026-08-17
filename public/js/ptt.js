// Push-to-Talk Controller — v3.0 (Bulletproof)
// Multi-strategy mobile PTT:
//  1. Desktop: keydown/keyup for Volume Up key
//  2. Mobile: volumechange on audio element (Android Chrome)
//  3. Mobile: MediaSession action hooks (Android media focus)
//  4. Mobile: Side-edge squeeze zone (transparent overlay on left edge)
//  5. On-screen button: hold or tap-toggle

class PTTController {
  constructor() {
    // Strict state machine: 'idle' | 'requesting' | 'transmitting' | 'blocked'
    this._state = 'idle';

    this.isToggleMode = false;
    this.transportMode = 'auto'; // Auto mode: tries WebRTC P2P + falls back to Socket.IO relay
    this.currentChannelId = null;
    this.pttButtonEl = null;

    // Volume detection
    this._volProbeAudio = null;
    this._volReady = false;
    this._volDebounceTimer = null;
    this._lastVolAction = 0;

    this.squeezeActive = false;

    // ── Anti-spam / anti-hang guards ──────────────────────────────────────
    this._actionCooldownMs = 150;   // Min ms between any PTT action (responsive)
    this._lastActionTime = 0;
    this._pendingRequest = false;   // True while we're waiting for server grant/deny
    this._requestTimeoutId = null;  // Safety timeout if server never responds

    this._initHardwareKeys();
    this._initMobileVolume();
    this._initSideEdgeZone();
  }

  // ─── Getters ─────────────────────────────────────────────────────────────
  get isPTTActive()  { return this._state === 'transmitting'; }
  get isBlocked()    { return this._state === 'blocked'; }
  get isRequesting() { return this._state === 'requesting'; }

  // ─── Public API ──────────────────────────────────────────────────────────
  setButtonElement(el) {
    this.pttButtonEl = el;
    this._attachButtonListeners();
  }

  setChannel(channelId) {
    this.currentChannelId = channelId;
    this._updateMediaMetadata();
  }

  setTransportMode(mode) {
    if (['socket', 'webrtc', 'auto'].includes(mode)) {
      this.transportMode = mode;
      console.log('[PTT] Transport mode set to:', mode);
      if (window.uiController && typeof window.uiController.updateTransportBadge === 'function') {
        window.uiController.updateTransportBadge(mode);
      }
    }
  }

  notifyICEFailure() {
    if (this.transportMode === 'webrtc' || this.transportMode === 'auto') {
      console.warn('[PTT] WebRTC ICE failed (College Wi-Fi AP isolation). Auto-switching to Socket.IO Relay.');
      this.setTransportMode('socket');
      if (window.uiController) {
        window.uiController.showToast('Switched to College Wi-Fi Socket Relay mode', 'warning');
      }
    }
  }

  setToggleMode(enabled) {
    this.isToggleMode = !!enabled;
    if (this._state === 'transmitting' || this._state === 'requesting') {
      this.stopPTT();
    }
    console.log('[PTT] Toggle mode:', this.isToggleMode);
  }

  activateVolumeProbe() {
    this._startVolProbe();
  }

  // ─── Cooldown guard — prevents ALL rapid-fire actions ─────────────────
  _canAct() {
    const now = Date.now();
    if (now - this._lastActionTime < this._actionCooldownMs) {
      console.log('[PTT] Action throttled (cooldown).');
      return false;
    }
    this._lastActionTime = now;
    return true;
  }

  async startPTT() {
    if (this._state !== 'idle') {
      console.log(`[PTT] startPTT ignored — state is '${this._state}', not 'idle'.`);
      return;
    }
    if (!this.currentChannelId) return;
    if (this._pendingRequest) {
      console.log('[PTT] startPTT ignored — already have a pending request.');
      return;
    }

    this._pendingRequest = true;
    this._setState('requesting');

    // Safety: If the server never responds, auto-reset after 5s
    clearTimeout(this._requestTimeoutId);
    this._requestTimeoutId = setTimeout(() => {
      if (this._state === 'requesting') {
        console.warn('[PTT] Request timed out — force resetting to idle.');
        this._pendingRequest = false;
        this._setState('idle');
      }
    }, 5000);

    window.socketManager.requestPTT(this.currentChannelId, '');
  }

  stopPTT() {
    if (this._state === 'idle') return;

    const wasTransmitting = this._state === 'transmitting';
    const wasRequesting = this._state === 'requesting';

    // Clean up pending request state
    this._pendingRequest = false;
    clearTimeout(this._requestTimeoutId);

    this._setState('idle');

    if (wasTransmitting) {
      if (window.webrtcManager) window.webrtcManager.stopBroadcast();
      if (window.audioEngine) window.audioEngine.stopRecordingStream();
      window.audioEngine.playBeep('stop');
      window.socketManager.releasePTT(this.currentChannelId);
    } else if (wasRequesting) {
      window.socketManager.releasePTT(this.currentChannelId);
    }
  }

  // ─── Server event callbacks ──────────────────────────────────────────────
  onFloorGranted() {
    clearTimeout(this._requestTimeoutId);
    this._pendingRequest = false;

    if (this._state !== 'requesting') {
      console.warn('[PTT] Floor granted but state is not requesting — releasing.');
      window.socketManager.releasePTT(this.currentChannelId);
      return;
    }

    this._setState('transmitting');
    window.audioEngine.playBeep('start');

    if (window.audioEngine.audioCtx && window.audioEngine.audioCtx.state === 'suspended') {
      window.audioEngine.audioCtx.resume().then(() => {
        console.log('[PTT] AudioContext resumed before broadcast.');
      });
    }

    // 1. Socket.IO Voice Relay Mode (College Wi-Fi safe)
    if (this.transportMode === 'socket' || this.transportMode === 'auto') {
      window.audioEngine.startRecordingStream((chunk, mimeType) => {
        if (this._state === 'transmitting' && this.currentChannelId) {
          window.socketManager.sendAudioChunk(this.currentChannelId, chunk, mimeType);
        }
      });
    }

    // 2. WebRTC P2P Mode
    if (this.transportMode === 'webrtc' || this.transportMode === 'auto') {
      window.socketManager.getChannelListeners(this.currentChannelId, (res) => {
        if (this._state !== 'transmitting') return;
        const listenerIds = res ? res.listeners : [];
        if (window.webrtcManager) {
          window.webrtcManager.startBroadcast(listenerIds);
        }
      });
    }
  }

  onFloorDenied(currentSpeaker) {
    clearTimeout(this._requestTimeoutId);
    this._pendingRequest = false;

    this._setState('blocked');
    window.uiController.showToast(`Floor busy — ${currentSpeaker || 'someone'} is talking.`, 'warning');
    setTimeout(() => {
      if (this._state === 'blocked') this._setState('idle');
    }, 2000);
  }

  onFloorActive() {
    if (this._state === 'transmitting' || this._state === 'requesting') {
      this.stopPTT();
    }
    this._setState('blocked');
  }

  onFloorReleased() {
    if (this._state === 'blocked') this._setState('idle');
  }

  // ─── Internal state machine ───────────────────────────────────────────────
  _setState(newState) {
    if (this._state === newState) return;
    console.log(`[PTT] ${this._state} → ${newState}`);
    this._state = newState;
    window.uiController.updatePTTState(newState);
    this._updateMediaMetadata();
  }

  _handleTogglePress() {
    if (!this.currentChannelId) return;
    if (!this._canAct()) return;

    if (this._state === 'transmitting' || this._state === 'requesting') {
      this.stopPTT();
    } else if (this._state === 'idle') {
      this.startPTT();
    }
    // If 'blocked', ignore — can't start/stop
  }

  // ─── Strategy 1: Desktop keyboard volume up ───────────────────────────────
  _initHardwareKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this._isVolUp(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.isToggleMode) {
        this._handleTogglePress();
      } else {
        if (this._canAct() && this._state === 'idle') this.startPTT();
      }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
      if (!this._isVolUp(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.isToggleMode) this.stopPTT();
    }, { capture: true });

    // Native Capacitor Event from MainActivity.java
    window.addEventListener('volumeButton', (e) => {
      // e.detail comes from Capacitor bridge (we send JSON string, some plugins parse it but let's be safe)
      const data = typeof e.detail === 'string' ? JSON.parse(e.detail) : (e.detail || {});
      
      if (data.action === 'down') {
        if (this.isToggleMode) {
          this._handleTogglePress();
        } else {
          if (this._canAct() && this._state === 'idle') this.startPTT();
        }
      } else if (data.action === 'up') {
        if (!this.isToggleMode) this.stopPTT();
      }
    });
  }

  _isVolUp(e) {
    const k = (e.key || '').toLowerCase();
    const c = (e.code || '').toLowerCase();
    return (
      k === 'audiovolumeup' || k === 'volumeup' ||
      c === 'audiovolumeup' || c === 'volumeup' ||
      e.keyCode === 24 || e.which === 24
    );
  }

  // ─── Strategy 2: Mobile volumechange on audio element ────────────────────
  // Works on Android Chrome when a media audio session is active.
  // Does NOT work on iOS — Apple blocks it by design.
  _initMobileVolume() {
    try {
      const audio = document.createElement('audio');
      audio.id = 'vol-probe-audio';
      audio.loop = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 0.01; // near-silent but NOT muted so session stays active
      audio.style.display = 'none';

      // 10-second silent MP3 data URI (convinces browser of real continuous playback)
      audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGFtZTMuOTguNCAoYmV0YSkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+0MUAAAP8AAAAAZgAAB/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+0MUAAAP8AAAAAZgAAB/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+0MUAAAP8AAAAAZgAAB/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+0MUAAAP8AAAAAZgAAB/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/';

      document.body.appendChild(audio);
      this._volProbeAudio = audio;

      // The volumechange fires when:
      //   a) JS changes audio.volume (we DON'T want to react to that)
      //   b) System volume changes while the audio element is active
      // We track JS-originated changes using a flag.
      this._volChangingByJS = false;
      audio.addEventListener('volumechange', () => {
        if (this._volChangingByJS) {
          this._volChangingByJS = false;
          return; // skip JS-triggered changes
        }
        this._onVolumeChange();
      });
    } catch (err) {
      console.warn('[PTT] Mobile volume detection init failed:', err);
    }
  }

  _startVolProbe() {
    if (!this._volProbeAudio) return;

    // Try to register a MediaSession so Android treats us as a media app.
    // This makes volume buttons control the "media" volume channel, which
    // is required for volumechange events to fire on hardware press.
    if ('mediaSession' in navigator) {
      try {
        this._updateMediaMetadata();

        // Bind media control buttons to PTT toggle
        // This makes lock screen widgets, Bluetooth headset buttons, and smartwatch controls work!
        const pttAction = () => {
          console.log('[PTT] MediaSession action triggered');
          if (this.isToggleMode) {
            this._handleTogglePress();
          } else {
            // When using physical media buttons, enforce toggle mode automatically
            // so they don't have to hold the button down.
            this.setToggleMode(true);
            document.getElementById('toggle-mode-checkbox').checked = true;
            this._handleTogglePress();
          }
        };

        navigator.mediaSession.setActionHandler('play', pttAction);
        navigator.mediaSession.setActionHandler('pause', pttAction);
        navigator.mediaSession.setActionHandler('previoustrack', pttAction);
        navigator.mediaSession.setActionHandler('nexttrack', pttAction);
        
        console.log('[PTT] MediaSession registered for Lock Screen widget.');
      } catch (e) {
        console.warn('[PTT] MediaSession setup failed:', e);
      }
    }

    this._volProbeAudio.play()
      .then(() => {
        this._volReady = true;
        console.log('[PTT] Volume probe active — volume button PTT enabled.');
      })
      .catch((err) => {
        console.warn('[PTT] Volume probe play failed (autoplay policy):', err);
        // Not fatal — on-screen button still works
      });
  }

  _updateMediaMetadata() {
    if ('mediaSession' in navigator && window.channelManager && this.currentChannelId) {
      const channel = window.channelManager.getChannelById(this.currentChannelId);
      if (channel) {
        let titlePrefix = 'IDLE';
        if (this._state === 'transmitting') {
          titlePrefix = '🔴 TRANSMITTING';
        } else if (this._state === 'receiving') {
          // Find if there is an active speaker name
          const speakerNameEl = document.getElementById('speaker-name');
          const speakerName = (speakerNameEl && speakerNameEl.textContent) ? speakerNameEl.textContent : 'Someone';
          titlePrefix = `🟢 TALKING: ${speakerName}`;
        } else if (this._state === 'requesting') {
          titlePrefix = 'Connecting mic...';
        } else if (this._state === 'blocked') {
          titlePrefix = 'Floor Busy';
        }

        navigator.mediaSession.metadata = new MediaMetadata({
          title: `${titlePrefix} | ${channel.name}`,
          artist: 'Robofest 2.0 Walkie-Talkie',
          artwork: [
            { src: '/assets/walkie-icon.png', sizes: '192x192', type: 'image/png' },
            { src: '/assets/walkie-icon.png', sizes: '512x512', type: 'image/png' }
          ]
        });

        // Enforce the 'playing' state so the lockscreen controls stay visible
        navigator.mediaSession.playbackState = 'playing';
      }
    }
  }

  _onVolumeChange() {
    if (!this._volReady) return;
    if (!this.currentChannelId) return;

    // Guard: 400ms min between actions to prevent double-fire
    const now = Date.now();
    if (now - this._lastVolAction < 400) return;
    this._lastVolAction = now;

    // Restore probe volume level silently (so next press still fires)
    clearTimeout(this._volDebounceTimer);
    this._volDebounceTimer = setTimeout(() => {
      this._handleTogglePress();

      // Restore volume after a tiny delay so the next press fires another event
      setTimeout(() => {
        if (this._volProbeAudio) {
          this._volChangingByJS = true;
          this._volProbeAudio.volume = 0.01;
        }
      }, 200);
    }, 100);
  }

  // ─── Strategy 3: Side-Edge Squeeze Zone ──────────────────────────────────
  // Creates a transparent 40px-wide strip along the LEFT edge of the screen.
  // Users can squeeze/tap the left side of their phone (where the volume button
  // is on most Android phones) to trigger PTT — no JS permission needed.
  _initSideEdgeZone() {
    // Only create on touch devices
    if (!('ontouchstart' in window)) return;

    const zone = document.createElement('div');
    zone.id = 'squeeze-zone';
    zone.style.cssText = `
      position: fixed;
      top: 30%;
      left: 0;
      width: 44px;
      height: 40%;
      z-index: 8000;
      background: transparent;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
      cursor: pointer;
    `;

    // Visual feedback indicator
    const indicator = document.createElement('div');
    indicator.style.cssText = `
      position: absolute;
      top: 50%;
      left: 6px;
      transform: translateY(-50%);
      width: 4px;
      height: 40px;
      background: rgba(215, 25, 33, 0.3);
      border-radius: 2px;
      transition: all 0.15s ease;
    `;
    zone.appendChild(indicator);
    document.body.appendChild(zone);
    this._squeezeZoneIndicator = indicator;

    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.squeezeActive = true;
      indicator.style.background = 'rgba(215, 25, 33, 0.8)';
      indicator.style.height = '60px';

      if (this.isToggleMode) {
        this._handleTogglePress();
      } else {
        if (this._canAct() && this._state === 'idle') this.startPTT();
      }
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => {
      e.preventDefault(); // Prevent gesture scrolling & keep PTT active even if finger slides
    }, { passive: false });

    zone.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.squeezeActive = false;
      indicator.style.background = 'rgba(215, 25, 33, 0.3)';
      indicator.style.height = '40px';

      if (!this.isToggleMode) this.stopPTT();
    }, { passive: false });

    zone.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this.squeezeActive = false;
      indicator.style.background = 'rgba(215, 25, 33, 0.3)';
      indicator.style.height = '40px';
      if (!this.isToggleMode) this.stopPTT();
    }, { passive: false });

    console.log('[PTT] Side-edge squeeze zone created on left edge.');
  }

  // ─── On-screen PTT button (Movement-Immune Touch & Pointer Engine) ────────
  _attachButtonListeners() {
    if (!this.pttButtonEl) return;

    let isTouching = false;

    // Mobile Touch Events: Guaranteed immunity to finger wiggling/sliding
    this.pttButtonEl.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (isTouching) return; // Prevent duplicate touch events
      isTouching = true;

      if (this.isToggleMode) {
        this._handleTogglePress();
      } else {
        if (this._canAct() && this._state === 'idle') this.startPTT();
      }
    }, { passive: false });

    // Ignore finger sliding! Moving finger will NEVER cancel microphone recording
    this.pttButtonEl.addEventListener('touchmove', (e) => {
      e.preventDefault();
    }, { passive: false });

    this.pttButtonEl.addEventListener('touchend', (e) => {
      e.preventDefault();
      isTouching = false;
      if (!this.isToggleMode) this.stopPTT();
    }, { passive: false });

    this.pttButtonEl.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      isTouching = false;
      if (!this.isToggleMode) this.stopPTT();
    }, { passive: false });

    // Desktop Mouse / Pointer Events
    this.pttButtonEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return; // Handled by touch events
      e.preventDefault();
      try {
        if (e.pointerId != null) this.pttButtonEl.setPointerCapture(e.pointerId);
      } catch (_) {}

      if (this.isToggleMode) {
        this._handleTogglePress();
      } else {
        if (this._canAct() && this._state === 'idle') this.startPTT();
      }
    });

    this.pttButtonEl.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      try {
        if (e.pointerId != null) this.pttButtonEl.releasePointerCapture(e.pointerId);
      } catch (_) {}
      if (!this.isToggleMode) this.stopPTT();
    });

    this.pttButtonEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

window.pttController = new PTTController();
