// Web Audio Engine — AudioContext, Beeps, Haptics & Mic Access
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.mediaStream = null;
    this.micPromise = null;
    this.nextPCMPlaybackTime = 0;
    this.isPCMRecording = false;
    this.pcmSourceNode = null;
    this.pcmWorkletNode = null;
    this.pcmProcessorNode = null;
    this._workletLoaded = false;
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

  // ─── Socket.IO Voice Relay Streamer (AudioWorklet + ScriptProcessor fallback) ───
  async startRecordingStream(onChunk) {
    this.stopRecordingStream();

    try {
      const stream = await this.requestMicPermission();
      const audioCtx = this.initAudioContext();

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const nativeSampleRate = audioCtx.sampleRate;
      this.pcmSourceNode = audioCtx.createMediaStreamSource(stream);

      // ── Strategy 1: Modern AudioWorklet (Chrome 66+, Firefox 76+, desktop & mobile) ──
      // Fixes: ScriptProcessorNode produces silence on Chrome desktop 127+
      if (audioCtx.audioWorklet) {
        try {
          if (!this._workletLoaded) {
            await audioCtx.audioWorklet.addModule('/js/pcm-processor.js');
            this._workletLoaded = true;
          }
          this.pcmWorkletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');

          // Pin to window to prevent V8 GC from destroying the node mid-transmission
          window._activePCMWorklet = this.pcmWorkletNode;
          window._activePCMSource = this.pcmSourceNode;

          this.pcmWorkletNode.port.onmessage = (event) => {
            if (this.isPCMRecording && typeof onChunk === 'function') {
              onChunk(event.data, `pcm/${nativeSampleRate}`);
            }
          };

          this.pcmSourceNode.connect(this.pcmWorkletNode);
          this.pcmWorkletNode.connect(audioCtx.destination);
          this.isPCMRecording = true;
          console.log(`[AudioEngine] ✅ AudioWorklet PCM started (${nativeSampleRate} Hz)`);
          return;
        } catch(workletErr) {
          console.warn('[AudioEngine] AudioWorklet unavailable, using ScriptProcessor:', workletErr.message);
        }
      }

      // ── Strategy 2: ScriptProcessorNode fallback (iOS Safari, older browsers) ──
      const bufferSize = 4096;
      this.pcmProcessorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      window._activePCMProcessor = this.pcmProcessorNode;
      window._activePCMSource = this.pcmSourceNode;

      this.pcmProcessorNode.onaudioprocess = (e) => {
        if (this.isPCMRecording && typeof onChunk === 'function') {
          const float32Data = e.inputBuffer.getChannelData(0);
          const int16Array = new Int16Array(float32Data.length);
          for (let i = 0; i < float32Data.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Data[i]));
            int16Array[i] = s < 0 ? s * 32768 : s * 32767;
          }
          onChunk(int16Array.buffer, `pcm/${nativeSampleRate}`);
        }
      };

      this.pcmSourceNode.connect(this.pcmProcessorNode);
      this.pcmProcessorNode.connect(audioCtx.destination);
      this.isPCMRecording = true;
      console.log(`[AudioEngine] ✅ ScriptProcessor PCM started (${nativeSampleRate} Hz)`);
    } catch(err) {
      console.error('[AudioEngine] PCM Streamer failed:', err);
    }
  }

  stopRecordingStream() {
    this.isPCMRecording = false;
    if (this.pcmWorkletNode) {
      try { this.pcmWorkletNode.disconnect(); } catch(_) {}
      this.pcmWorkletNode = null;
      window._activePCMWorklet = null;
    }
    if (this.pcmProcessorNode) {
      try { this.pcmProcessorNode.disconnect(); } catch(_) {}
      this.pcmProcessorNode = null;
      window._activePCMProcessor = null;
    }
    if (this.pcmSourceNode) {
      try { this.pcmSourceNode.disconnect(); } catch(_) {}
      this.pcmSourceNode = null;
      window._activePCMSource = null;
    }
    console.log('[AudioEngine] PCM Streamer stopped.');
  }

  // ─── Socket.IO Voice Relay Playback Engine (Direct PCM AudioBuffer) ─────────
  playAudioChunk(rawChunk, mimeType) {
    if (!rawChunk) return;

    // Normalize to ArrayBuffer — Socket.IO may deliver Uint8Array or Buffer on some platforms
    let arrayBuffer;
    if (rawChunk instanceof ArrayBuffer) {
      arrayBuffer = rawChunk;
    } else if (ArrayBuffer.isView(rawChunk)) {
      arrayBuffer = rawChunk.buffer.slice(rawChunk.byteOffset, rawChunk.byteOffset + rawChunk.byteLength);
    } else {
      return;
    }

    if (arrayBuffer.byteLength < 2) return;

    // Parse native sample rate from mimeType header (e.g. 'pcm/44100' or 'pcm/48000')
    let sampleRate = 44100;
    if (mimeType && typeof mimeType === 'string' && mimeType.startsWith('pcm/')) {
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
        float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 32768 : 32767);
      }

      const audioBuffer = audioCtx.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);

      const sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(audioCtx.destination);

      const currentTime = audioCtx.currentTime;
      // 60ms initial jitter buffer prevents underrun gaps on first chunk
      if (!this.nextPCMPlaybackTime || this.nextPCMPlaybackTime < currentTime) {
        this.nextPCMPlaybackTime = currentTime + 0.06;
      }

      sourceNode.start(this.nextPCMPlaybackTime);
      this.nextPCMPlaybackTime += audioBuffer.duration;
    } catch(err) {
      console.warn('[AudioEngine] Playback error:', err);
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
