// Push-to-Talk Controller — Rebuilt with strict state machine
// v2.3 — fixes toggle glitch, stuck state, and mobile volume button
class PTTController {
  constructor() {
    // Strict state machine: 'idle' | 'requesting' | 'transmitting' | 'blocked'
    this._state = 'idle';

    this.isToggleMode = false;
    this.currentChannelId = null;
    this.pttButtonEl = null;

    // Mobile volume detection
    this._volProbeAudio = null;
    this._volReady = false;
    this._volDebounceTimer = null;
    this._lastVolAction = 0; // timestamp guard against double-fire

    // Prevent startPTT from being called again while already requesting
    this._requesting = false;

    this._initHardwareKeys();
    this._initMobileVolume();
  }

  // ─── Getters ────────────────────────────────────────────────────────────────
  get isPTTActive()    { return this._state === 'transmitting'; }
  get isBlocked()      { return this._state === 'blocked'; }
  get isRequesting()   { return this._state === 'requesting'; }

  // ─── Public API ─────────────────────────────────────────────────────────────
  setButtonElement(el) {
    this.pttButtonEl = el;
    this._attachButtonListeners();
  }

  setChannel(channelId) {
    this.currentChannelId = channelId;
  }

  setToggleMode(enabled) {
    this.isToggleMode = !!enabled;
    // Always stop cleanly when changing mode
    if (this._state === 'transmitting' || this._state === 'requesting') {
      this.stopPTT();
    }
    console.log('[PTT] Toggle mode:', this.isToggleMode);
  }

  // ─── PTT start / stop ────────────────────────────────────────────────────────
  async startPTT() {
    // Guard: only start from idle state
    if (this._state !== 'idle') return;
    if (!this.currentChannelId) return;

    this._setState('requesting');

    try {
      await window.audioEngine.requestMicPermission();
    } catch (err) {
      window.uiController.showToast('Microphone access is required to talk.', 'error');
      this._setState('idle');
      return;
    }

    // Double-check state hasn't changed while awaiting mic
    if (this._state !== 'requesting') return;

    const mimeType = window.audioEngine.getSupportedMimeType();
    window.socketManager.requestPTT(this.currentChannelId, mimeType);
  }

  stopPTT() {
    if (this._state === 'idle') return;

    const wasTransmitting = this._state === 'transmitting';

    this._setState('idle');

    if (wasTransmitting) {
      window.audioEngine.stopRecording();
      window.socketManager.releasePTT(this.currentChannelId);
    }
  }

  // ─── Server event callbacks ──────────────────────────────────────────────────
  onFloorGranted() {
    if (this._state !== 'requesting') return; // stale grant, ignore
    this._setState('transmitting');

    window.audioEngine.startRecording(this.currentChannelId).catch((err) => {
      console.error('[PTT] Recording failed to start:', err);
      this.stopPTT();
    });
  }

  onFloorDenied(currentSpeaker) {
    this._setState('blocked');
    window.uiController.showToast(`Floor busy — ${currentSpeaker || 'someone'} is talking.`, 'warning');
    // Auto-unblock after 2s so the user can try again
    setTimeout(() => {
      if (this._state === 'blocked') this._setState('idle');
    }, 2000);
  }

  onFloorActive() {
    // Another user grabbed the floor; block local PTT
    if (this._state === 'transmitting' || this._state === 'requesting') {
      this.stopPTT();
    }
    this._setState('blocked');
  }

  onFloorReleased() {
    // Remote speaker released; unblock
    if (this._state === 'blocked') this._setState('idle');
  }

  // Alias used by older app.js code
  activateVolumeProbe() {
    this._startVolProbe();
  }

  // ─── Internal state machine ──────────────────────────────────────────────────
  _setState(newState) {
    if (this._state === newState) return;
    console.log(`[PTT] ${this._state} → ${newState}`);
    this._state = newState;
    window.uiController.updatePTTState(newState);
  }

  // ─── Desktop keyboard listeners ───────────────────────────────────────────────
  _initHardwareKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this._isVolUp(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.isToggleMode) {
        this._handleTogglePress();
      } else {
        if (this._state === 'idle') this.startPTT();
      }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
      if (!this._isVolUp(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.isToggleMode) {
        this.stopPTT();
      }
    }, { capture: true });
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

  // ─── Mobile volume button via silent audio + volumechange event ────────────
  _initMobileVolume() {
    // Works on both touch and non-touch devices — attach unconditionally.
    // The audio element approach only fires on mobile where keyboard events are blocked.
    try {
      const audio = document.createElement('audio');
      audio.id = 'vol-probe-audio';
      audio.loop = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 0.5;
      audio.style.display = 'none';

      // Tiny silent WAV to keep audio session alive
      audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGFwYQAAAAA=';
      document.body.appendChild(audio);
      this._volProbeAudio = audio;

      audio.addEventListener('volumechange', () => this._onVolumeChange());
    } catch (err) {
      console.warn('[PTT] Mobile volume detection init failed:', err);
    }
  }

  _startVolProbe() {
    if (!this._volProbeAudio) return;
    this._volProbeAudio.play()
      .then(() => {
        this._volReady = true;
        console.log('[PTT] Volume probe active — hardware volume buttons will trigger PTT.');
      })
      .catch((err) => {
        console.warn('[PTT] Volume probe play failed:', err);
      });
  }

  _onVolumeChange() {
    if (!this._volReady) return;
    if (!this.currentChannelId) return;

    // Strict debounce: ignore repeated events within 400ms of the last action
    const now = Date.now();
    if (now - this._lastVolAction < 400) return;
    this._lastVolAction = now;

    clearTimeout(this._volDebounceTimer);
    this._volDebounceTimer = setTimeout(() => {
      this._handleTogglePress();
    }, 120);
  }

  // ─── Toggle press handler (shared by volume button + toggle mode button) ────
  _handleTogglePress() {
    if (!this.currentChannelId) return;

    if (this._state === 'transmitting' || this._state === 'requesting') {
      this.stopPTT();
    } else if (this._state === 'idle') {
      this.startPTT();
    }
    // If blocked, do nothing — wait for auto-unblock
  }

  // ─── On-screen PTT button (pointer events) ────────────────────────────────
  _attachButtonListeners() {
    if (!this.pttButtonEl) return;

    this.pttButtonEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        if (e.pointerId != null) this.pttButtonEl.setPointerCapture(e.pointerId);
      } catch (_) {}

      if (this.isToggleMode) {
        this._handleTogglePress();
      } else {
        if (this._state === 'idle') this.startPTT();
      }
    });

    this.pttButtonEl.addEventListener('pointerup', (e) => {
      e.preventDefault();
      try {
        if (e.pointerId != null) this.pttButtonEl.releasePointerCapture(e.pointerId);
      } catch (_) {}

      if (!this.isToggleMode) {
        this.stopPTT();
      }
    });

    this.pttButtonEl.addEventListener('pointercancel', (e) => {
      e.preventDefault();
      if (!this.isToggleMode) {
        this.stopPTT();
      }
    });

    this.pttButtonEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

window.pttController = new PTTController();
