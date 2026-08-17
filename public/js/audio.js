// Web Audio Engine — AudioContext, Beeps, Haptics & Mic Access
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.micPromise = null;
    this.mediaRecorder = null;
    this.currentMimeType = '';
    this.nextPlaybackTime = 0;
    this.setupIOSAudioUnlock();
  }

  // Global listener to unlock iOS WebAudio & AudioContext on user gesture
  setupIOSAudioUnlock() {
    const unlock = () => {
      if (!this.audioCtx) {
        this.initAudioContext();
      } else if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      try {
        if (this.audioCtx) {
          const buffer = this.audioCtx.createBuffer(1, 1, 22050);
          const source = this.audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(this.audioCtx.destination);
          source.start(0);
        }
      } catch (e) {}
    };

    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    window.addEventListener('click', unlock, { passive: true });
  }

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

  vibrate(pattern = [30]) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (e) {}
    }
  }

  // Synthesize PTT Roger Beeps & Haptic Feedback
  playBeep(type = 'start') {
    this.vibrate(type === 'start' ? [40] : [20, 30, 20]);
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

  async requestMicPermission() {
    if (this.mediaStream && this.mediaStream.active) return this.mediaStream;
    if (this.micPromise) return this.micPromise;

    this.micPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000
      }
    }).then(stream => {
      this.mediaStream = stream;
      this.micPromise = null;
      return stream;
    }).catch(err => {
      this.micPromise = null;
      console.error('[Audio] Mic permission denied:', err);
      throw err;
    });

    return this.micPromise;
  }

  stopMic() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  }

  // ─── Socket.IO Voice Relay Streamer ──────────────────────────────────────
  async startRecordingStream(onChunk) {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.stopRecordingStream();
    }

    const stream = await this.requestMicPermission();

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else if (MediaRecorder.isTypeSupported('audio/aac')) mimeType = 'audio/aac';
      else mimeType = '';
    }

    const options = mimeType ? { mimeType } : {};
    this.mediaRecorder = new MediaRecorder(stream, options);
    this.currentMimeType = this.mediaRecorder.mimeType || mimeType;

    this.mediaRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0 && typeof onChunk === 'function') {
        const arrayBuffer = await e.data.arrayBuffer();
        onChunk(arrayBuffer, this.currentMimeType);
      }
    };

    // Emit chunk every 100ms for low-latency transmission
    this.mediaRecorder.start(100);
    console.log(`[AudioEngine] Socket Relay MediaRecorder started (${this.currentMimeType})`);
  }

  stopRecordingStream() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch(_) {}
    }
    this.mediaRecorder = null;
    console.log('[AudioEngine] Socket Relay MediaRecorder stopped.');
  }

  // ─── Socket.IO Voice Relay Playback Engine ──────────────────────────────
  playAudioChunk(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;

    this.initAudioContext();
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const bufferCopy = arrayBuffer.slice(0);
    this.audioCtx.decodeAudioData(bufferCopy, (decodedBuffer) => {
      try {
        const source = this.audioCtx.createBufferSource();
        source.buffer = decodedBuffer;
        source.connect(this.audioCtx.destination);

        const currentTime = this.audioCtx.currentTime;
        if (this.nextPlaybackTime < currentTime) {
          this.nextPlaybackTime = currentTime + 0.05; // 50ms initial jitter cushion
        }

        source.start(this.nextPlaybackTime);
        this.nextPlaybackTime += decodedBuffer.duration;
      } catch (err) {
        console.warn('[AudioEngine] Buffer source playback failed:', err);
      }
    }, (err) => {
      console.warn('[AudioEngine] Audio chunk decode failed:', err);
    });
  }

  resetPlaybackQueue() {
    this.nextPlaybackTime = 0;
  }
}

window.audioEngine = new AudioEngine();
