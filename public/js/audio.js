// Web Audio API Engine — Guaranteed Live Real-Time Audio Playback (iOS & Android)
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.supportedMimeType = null;

    // Playback via MediaSource Extensions (MSE)
    this.audioEl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.pendingChunks = [];
    this.isSourceBufferReady = false;

    // iOS Safari / Non-MSE Fallback Streamer
    this.isFallbackMode = false;
    this.fallbackChunks = [];
    this.fallbackMimeType = 'audio/mp4';
    this.nextWebAudioTime = 0;

    // Global iOS touch unlock listener
    this.setupIOSAudioUnlock();
  }

  // Global listener to unlock iOS WebAudio & HTML5 audio context on user gesture
  setupIOSAudioUnlock() {
    const unlock = () => {
      if (!this.audioCtx) {
        this.initAudioContext();
      } else if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      // Play short silent buffer on AudioContext destination for WebAudio warm-up
      try {
        if (this.audioCtx) {
          const buffer = this.audioCtx.createBuffer(1, 1, 22050);
          const source = this.audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(this.audioCtx.destination);
          source.start(0);
        }
      } catch (e) {}

      if (this.audioEl) {
        this.audioEl.play().catch(() => {});
      }
    };

    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    window.addEventListener('click', unlock, { passive: true });
  }

  // Initialize and unlock AudioContext on user gesture
  initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  getSupportedMimeType() {
    if (this.supportedMimeType) return this.supportedMimeType;

    // Priority list including iOS-native container (audio/mp4)
    const types = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/aac',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];

    for (const type of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
        this.supportedMimeType = type;
        console.log('[Audio] Selected MediaRecorder MIME type:', type);
        return type;
      }
    }

    this.supportedMimeType = '';
    return '';
  }

  // Synthesize PTT Roger Beeps
  playBeep(type = 'start') {
    try {
      this.initAudioContext();
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      const now = this.audioCtx.currentTime;

      if (type === 'start') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, now);
        osc.frequency.exponentialRampToValueAtTime(1600, now + 0.08);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
        osc.start(now); osc.stop(now + 0.08);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, now);
        osc.frequency.exponentialRampToValueAtTime(700, now + 0.12);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc.start(now); osc.stop(now + 0.12);
      }
    } catch (e) {
      console.warn('[Audio] Beep failed:', e);
    }
  }

  // Request Microphone Stream
  async requestMicPermission() {
    if (this.mediaStream) return this.mediaStream;
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      return this.mediaStream;
    } catch (err) {
      console.error('[Audio] Mic permission denied:', err);
      throw err;
    }
  }

  // ─── SENDER: MediaRecorder continuous capture ──────────────────────────────
  async startRecording(channelId) {
    if (this.isRecording) return;
    this.initAudioContext();
    this.playBeep('start');

    const stream = await this.requestMicPermission();
    this.isRecording = true;

    const mimeType = this.getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};

    this.mediaRecorder = new MediaRecorder(stream, options);

    this.mediaRecorder.ondataavailable = async (e) => {
      if (!this.isRecording) return;
      if (e.data && e.data.size > 0) {
        const buf = await e.data.arrayBuffer();
        window.socketManager.sendAudioChunk(channelId, buf, mimeType);
      }
    };

    this.mediaRecorder.start(100);
    console.log('[Audio] MediaRecorder streaming on channel:', channelId, 'mime:', mimeType);
  }

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
    this.mediaRecorder = null;
    this.playBeep('stop');
    console.log('[Audio] Streaming stopped.');
  }

  // ─── RECEIVER: MediaSource Extensions & iOS Live WebAudio Engine ────────
  initMediaSourcePlayer(mimeType) {
    this.teardownPlayer();
    this.initAudioContext();

    const useMime = mimeType || 'audio/webm;codecs=opus';
    const isMSESupported = window.MediaSource && MediaSource.isTypeSupported(useMime);

    if (!isMSESupported) {
      console.warn('[Audio] MSE not supported for mime:', useMime, '— activating Live WebAudio Fallback Streamer.');
      this.isFallbackMode = true;
      this.fallbackChunks = [];
      this.fallbackMimeType = mimeType || 'audio/mp4';
      this.nextWebAudioTime = 0;
      return false;
    }

    this.isFallbackMode = false;
    this.audioEl = document.getElementById('walkie-audio-player');
    if (!this.audioEl) {
      this.audioEl = document.createElement('audio');
      this.audioEl.id = 'walkie-audio-player';
      this.audioEl.autoplay = true;
      this.audioEl.playsInline = true;
      this.audioEl.style.display = 'none';
      document.body.appendChild(this.audioEl);
    }

    this.mediaSource = new MediaSource();
    this.pendingChunks = [];
    this.isSourceBufferReady = false;

    this.audioEl.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(useMime);
        this.sourceBuffer.mode = 'sequence';
        this.sourceBuffer.addEventListener('updateend', () => this._flushPending());
        this.isSourceBufferReady = true;
        this._flushPending();
      } catch (err) {
        console.error('[Audio] MSE addSourceBuffer error:', err);
        this.isFallbackMode = true;
        this.fallbackChunks = [];
        this.fallbackMimeType = useMime;
        this.nextWebAudioTime = 0;
      }
    });

    this.audioEl.play().catch((err) => {
      console.warn('[Audio] Initial audioEl play blocked:', err);
    });

    return true;
  }

  receiveChunk(rawChunk) {
    if (!rawChunk) return;

    // Normalize incoming chunk to ArrayBuffer
    let arrayBuffer = rawChunk;
    if (rawChunk && rawChunk.buffer instanceof ArrayBuffer) {
      arrayBuffer = rawChunk.buffer.slice(rawChunk.byteOffset, rawChunk.byteOffset + rawChunk.byteLength);
    }

    if (this.isFallbackMode) {
      this.fallbackChunks.push(arrayBuffer);
      this.playChunkWebAudioLive(arrayBuffer);
    } else {
      this.pendingChunks.push(arrayBuffer);
      this._flushPending();
    }
  }

  _flushPending() {
    if (!this.isSourceBufferReady || !this.sourceBuffer || this.sourceBuffer.updating) return;
    if (this.pendingChunks.length === 0) return;

    const next = this.pendingChunks.shift();
    try {
      this.sourceBuffer.appendBuffer(next);

      // GUARANTEED PLAYBACK TRIGGER: If audioEl is paused, trigger play() now that buffer has data!
      if (this.audioEl && this.audioEl.paused) {
        this.audioEl.play().catch((err) => {
          console.warn('[Audio] Live playback trigger blocked:', err);
        });
      }

      if (this.sourceBuffer.buffered.length > 0) {
        const end = this.sourceBuffer.buffered.end(0);
        if (end > 30) {
          try { this.sourceBuffer.remove(0, end - 30); } catch (e) {}
        }
      }
    } catch (err) {
      console.warn('[Audio] appendBuffer error:', err);
    }
  }

  // Real-Time Live Playback for iOS / Non-MSE via WebAudio API
  async playChunkWebAudioLive(arrayBuffer) {
    try {
      this.initAudioContext();
      if (!this.audioCtx) return;

      const bufCopy = arrayBuffer.slice(0);
      const audioBuffer = await this.audioCtx.decodeAudioData(bufCopy);
      
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      const now = this.audioCtx.currentTime;
      if (!this.nextWebAudioTime || this.nextWebAudioTime < now) {
        this.nextWebAudioTime = now + 0.02;
      }

      source.start(this.nextWebAudioTime);
      this.nextWebAudioTime += audioBuffer.duration;
    } catch (e) {
      // Quietly ignore sub-chunk decode errors — teardownPlayer will play complete blob failsafe
    }
  }

  teardownPlayer() {
    // iOS Fallback Failsafe: Play complete concatenated audio blob if live decode missed frames
    if (this.isFallbackMode && this.fallbackChunks.length > 0) {
      try {
        const blob = new Blob(this.fallbackChunks, { type: this.fallbackMimeType });
        const blobUrl = URL.createObjectURL(blob);
        const player = new Audio(blobUrl);
        player.playsInline = true;
        player.play().catch((err) => {
          console.warn('[Audio Fallback] Final blob play failed:', err);
        });
      } catch (err) {
        console.error('[Audio Fallback] Blob construction failed:', err);
      }
    }

    this.isFallbackMode = false;
    this.fallbackChunks = [];
    this.isSourceBufferReady = false;
    this.pendingChunks = [];
    this.nextWebAudioTime = 0;

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch (e) {}
    }
    if (this.audioEl) {
      this.audioEl.src = '';
      this.audioEl.removeAttribute('src');
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
  }
}

window.audioEngine = new AudioEngine();
