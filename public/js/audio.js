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

  // ─── Socket.IO Voice Relay Streamer (PCM Direct Audio) ─────────────────────
  async startRecordingStream(onChunk) {
    this.stopRecordingStream();

    try {
      const stream = await this.requestMicPermission();
      const audioCtx = this.initAudioContext();

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      this.pcmSourceNode = audioCtx.createMediaStreamSource(stream);
      // 2048 buffer size gives ~46ms low-latency PCM slices at 44.1kHz / 48kHz
      this.pcmProcessorNode = (audioCtx.createScriptProcessor || audioCtx.createJavaScriptNode).call(audioCtx, 2048, 1, 1);

      const nativeSampleRate = audioCtx.sampleRate;

      this.pcmProcessorNode.onaudioprocess = (e) => {
        if (this.isPCMRecording && typeof onChunk === 'function') {
          const float32Data = e.inputBuffer.getChannelData(0);
          // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767] for 50% bandwidth optimization
          const int16Array = new Int16Array(float32Data.length);
          for (let i = 0; i < float32Data.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Data[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          onChunk(int16Array.buffer, `pcm/${nativeSampleRate}`);
        }
      };

      this.pcmSourceNode.connect(this.pcmProcessorNode);
      this.pcmProcessorNode.connect(audioCtx.destination);
      this.isPCMRecording = true;
      console.log(`[AudioEngine] Direct PCM Streamer started (${nativeSampleRate} Hz)`);
    } catch(err) {
      console.error('[AudioEngine] PCM Streamer failed to start:', err);
    }
  }

  stopRecordingStream() {
    this.isPCMRecording = false;
    if (this.pcmProcessorNode) {
      try { this.pcmProcessorNode.disconnect(); } catch(_) {}
      this.pcmProcessorNode = null;
    }
    if (this.pcmSourceNode) {
      try { this.pcmSourceNode.disconnect(); } catch(_) {}
      this.pcmSourceNode = null;
    }
    console.log('[AudioEngine] Direct PCM Streamer stopped.');
  }

  // ─── Socket.IO Voice Relay Playback Engine (Direct PCM AudioBuffer) ─────
  playAudioChunk(arrayBuffer, mimeType) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;

    // Parse sample rate from mimeType if available (e.g. 'pcm/44100')
    let sampleRate = 44100;
    if (mimeType && mimeType.startsWith('pcm/')) {
      const parsedRate = parseInt(mimeType.split('/')[1], 10);
      if (parsedRate && !isNaN(parsedRate)) sampleRate = parsedRate;
    }

    const audioCtx = this.initAudioContext();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    try {
      const int16Array = new Int16Array(arrayBuffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7FFF);
      }

      const audioBuffer = audioCtx.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);

      const sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(audioCtx.destination);

      const currentTime = audioCtx.currentTime;
      if (!this.nextPCMPlaybackTime || this.nextPCMPlaybackTime < currentTime) {
        this.nextPCMPlaybackTime = currentTime + 0.02; // 20ms initial cushion
      }

      sourceNode.start(this.nextPCMPlaybackTime);
      this.nextPCMPlaybackTime += audioBuffer.duration;
    } catch(err) {
      console.warn('[AudioEngine] PCM chunk playback error:', err);
    }
  }

  stopRelayPlayer() {
    this.nextPCMPlaybackTime = 0;
  }

  resetPlaybackQueue() {
    this.stopRelayPlayer();
  }
}

window.audioEngine = new AudioEngine();
