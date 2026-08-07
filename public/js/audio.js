// Web Audio API Engine — MediaRecorder Sender + MediaSource Receiver
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.supportedMimeType = null;
    // Playback via MediaSource Extensions
    this.audioEl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.pendingChunks = [];
    this.isSourceBufferReady = false;
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
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    for (const type of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
        this.supportedMimeType = type;
        return type;
      }
    }
    // Fallback — let browser pick
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
      console.error('[Audio] Mic denied:', err);
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

    // Send every chunk INCLUDING the first (which has codec headers)
    this.mediaRecorder.ondataavailable = async (e) => {
      if (!this.isRecording) return;
      if (e.data && e.data.size > 0) {
        const buf = await e.data.arrayBuffer();
        window.socketManager.sendAudioChunk(channelId, buf, mimeType);
      }
    };

    // timeslice=100ms — lower latency streaming
    this.mediaRecorder.start(100);
    console.log('[Audio] MediaRecorder streaming on channel:', channelId);
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

  // ─── RECEIVER: MediaSource Extensions streaming playback ─────────────────
  // Called ONCE when a new speaker starts (ptt:active), before chunks arrive.
  initMediaSourcePlayer(mimeType) {
    // Tear down previous session
    this.teardownPlayer();

    if (!window.MediaSource) {
      console.warn('[Audio] MediaSource not supported — falling back to AudioContext decoding');
      return false;
    }

    const useMime = mimeType || 'audio/webm;codecs=opus';
    if (!MediaSource.isTypeSupported(useMime)) {
      console.warn('[Audio] MSE mime not supported:', useMime);
      return false;
    }

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
        console.log('[Audio] MSE SourceBuffer ready, mime:', useMime);
        // Flush any chunks that arrived before sourceopen
        this._flushPending();
      } catch (err) {
        console.error('[Audio] MSE addSourceBuffer error:', err);
      }
    });

    // Start audio element
    this.audioEl.play().catch(() => {});
    return true;
  }

  teardownPlayer() {
    this.isSourceBufferReady = false;
    this.pendingChunks = [];
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

  // Receive a WebM chunk — buffer it, flush when SourceBuffer is idle
  receiveChunk(arrayBuffer) {
    this.pendingChunks.push(arrayBuffer);
    this._flushPending();
  }

  _flushPending() {
    if (!this.isSourceBufferReady) return;
    if (!this.sourceBuffer) return;
    if (this.sourceBuffer.updating) return;
    if (this.pendingChunks.length === 0) return;

    const next = this.pendingChunks.shift();
    try {
      this.sourceBuffer.appendBuffer(next);
      // Keep buffer lean — remove audio older than 30s to prevent quota error
      if (this.sourceBuffer.buffered.length > 0) {
        const end = this.sourceBuffer.buffered.end(0);
        if (end > 30) {
          try {
            this.sourceBuffer.remove(0, end - 30);
          } catch (e) {}
        }
      }
    } catch (err) {
      console.warn('[Audio] appendBuffer error:', err);
    }
  }

  // ─── Legacy AudioContext fallback for browsers without MSE ───────────────
  async playAudioChunkFallback(arrayBuffer) {
    try {
      this.initAudioContext();
      const buf = arrayBuffer.slice(0);
      const decoded = await this.audioCtx.decodeAudioData(buf);
      const src = this.audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(this.audioCtx.destination);
      src.start();
    } catch (e) {
      console.warn('[Audio] Fallback decode error:', e);
    }
  }
}

window.audioEngine = new AudioEngine();
