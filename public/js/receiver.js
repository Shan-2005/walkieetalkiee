// Robofest 2.0 Receiver Command Center — MSE Streaming Audio Engine
class ReceiverEngine {
  constructor() {
    this.socket = null;
    this.audioCtx = null;
    this.analyser = null;
    this.masterGain = null;
    this.channelGains = new Map();
    this.channelMuted = new Map();
    this.soloChannel = null;
    this.isMutedAll = false;
    this.isAudioUnlocked = false;
    // MSE player fields
    this.audioEl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.pendingChunks = [];
    this.isSourceBufferReady = false;
  }

  init() {
    this.setupSocketConnection();
    this.setupTouchUnlock();
    this.startSpectrumVisualizer();
  }

  setupTouchUnlock() {
    const overlay = document.getElementById('audio-unlock-overlay');
    const unlockBtn = document.getElementById('unlock-audio-btn');
    const unlock = () => {
      this.initAudioContext();
      this.isAudioUnlocked = true;
      if (overlay) overlay.classList.add('hidden');
      this.logTerminal('[SYSTEM] Mobile Audio Engine Activated 🔊');
    };
    if (unlockBtn) unlockBtn.addEventListener('click', unlock);
    if (overlay) overlay.addEventListener('click', unlock);
  }

  initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = 1.0;
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  getChannelGain(channelId) {
    if (!this.channelGains.has(channelId)) {
      this.initAudioContext();
      const gain = this.audioCtx.createGain();
      gain.gain.value = 1.0;
      gain.connect(this.masterGain);
      this.channelGains.set(channelId, gain);
      this.channelMuted.set(channelId, false);
    }
    return this.channelGains.get(channelId);
  }

  setupSocketConnection() {
    this.socket = io({ reconnection: true, transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => {
      this.logTerminal(`[SYSTEM] Socket connected: ${this.socket.id}`);
      this.socket.emit('receiver:subscribe', { name: 'Mobile Control Station' }, () => {
        this.logTerminal('[SYSTEM] Subscribed to ALL 10 channels.');
      });
    });

    this.socket.on('stats:update', (data) => this.updateStatsUI(data));

    this.socket.on('ptt:active', (data) => {
      const { channelId, userName, role, mimeType } = data;
      this.logTerminal(`[PTT START] <span class="active-talk">${channelId.toUpperCase()}</span> :: ${userName} (${role})`, 'active-talk');
      this.setChannelSpeakerUI(channelId, userName, true);
      this.initMediaSourcePlayer(mimeType || '');
    });

    this.socket.on('ptt:released', (data) => {
      const { channelId, userName } = data;
      this.logTerminal(`[PTT STOP] ${channelId.toUpperCase()} :: ${userName || 'User'} released floor`, 'release-talk');
      this.setChannelSpeakerUI(channelId, null, false);
      setTimeout(() => this.teardownPlayer(), 600);
    });

    this.socket.on('audio:chunk', (data) => {
      if (this.isMutedAll) return;
      if (this.channelMuted.get(data.channelId)) return;
      if (this.soloChannel && this.soloChannel !== data.channelId) return;
      this.receiveChunk(data.audioData);
    });
  }

  // ─── MediaSource Extensions streaming player ─────────────────────────────
  initMediaSourcePlayer(mimeType) {
    this.teardownPlayer();
    if (!window.MediaSource) return;
    const useMime = mimeType || 'audio/webm;codecs=opus';
    if (!MediaSource.isTypeSupported(useMime)) return;

    let audioEl = document.getElementById('receiver-audio-player');
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'receiver-audio-player';
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    this.audioEl = audioEl;
    this.mediaSource = new MediaSource();
    this.pendingChunks = [];
    this.isSourceBufferReady = false;
    audioEl.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(useMime);
        this.sourceBuffer.mode = 'sequence';
        this.sourceBuffer.addEventListener('updateend', () => this._flushPending());
        this.isSourceBufferReady = true;
        this._flushPending();
      } catch (err) {
        console.error('[Receiver MSE] addSourceBuffer error:', err);
      }
    });
    audioEl.play().catch(() => {});
  }

  teardownPlayer() {
    this.isSourceBufferReady = false;
    this.pendingChunks = [];
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch (e) {}
    }
    if (this.audioEl) { this.audioEl.src = ''; this.audioEl.removeAttribute('src'); }
    this.mediaSource = null;
    this.sourceBuffer = null;
  }

  receiveChunk(arrayBuffer) {
    this.pendingChunks.push(arrayBuffer);
    this._flushPending();
  }

  _flushPending() {
    if (!this.isSourceBufferReady || !this.sourceBuffer || this.sourceBuffer.updating) return;
    if (this.pendingChunks.length === 0) return;
    const next = this.pendingChunks.shift();
    try {
      this.sourceBuffer.appendBuffer(next);
      if (this.sourceBuffer.buffered.length > 0) {
        const end = this.sourceBuffer.buffered.end(0);
        if (end > 30) { try { this.sourceBuffer.remove(0, end - 30); } catch (e) {} }
      }
    } catch (err) { console.warn('[Receiver MSE] appendBuffer error:', err); }
  }

  // ─── Spectrum Visualizer ─────────────────────────────────────────────────
  startSpectrumVisualizer() {
    const canvas = document.getElementById('spectrum-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const renderFrame = () => {
      requestAnimationFrame(renderFrame);
      if (!this.analyser) return;
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      this.analyser.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 2.2;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
        gradient.addColorStop(0, '#06B6D4');
        gradient.addColorStop(1, '#FACC15');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 3;
      }
    };
    renderFrame();
  }

  // ─── UI Helpers ───────────────────────────────────────────────────────────
  logTerminal(msg, typeClass = '') {
    const body = document.getElementById('terminal-logs');
    if (!body) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${typeClass}`;
    entry.innerHTML = `<span class="timestamp">[${time}]</span> ${msg}`;
    body.appendChild(entry);
    body.scrollTop = body.scrollHeight;
  }

  setChannelSpeakerUI(channelId, speakerName, isActive) {
    const card = document.querySelector(`[data-receiver-channel="${channelId}"]`);
    if (!card) return;
    const speakerTag = card.querySelector('.live-speaker-tag');
    if (isActive) {
      card.classList.add('is-active-speaker');
      if (speakerTag) { speakerTag.textContent = `🎙️ ${speakerName}`; speakerTag.style.display = 'inline-block'; }
    } else {
      card.classList.remove('is-active-speaker');
      if (speakerTag) speakerTag.style.display = 'none';
    }
  }

  updateStatsUI(stats) {
    const totalEl = document.getElementById('receiver-total-online');
    if (totalEl) totalEl.textContent = stats.totalOnline || 0;
    if (stats.channelCounts) {
      for (const [chId, count] of Object.entries(stats.channelCounts)) {
        const card = document.querySelector(`[data-receiver-channel="${chId}"]`);
        if (card) {
          const countEl = card.querySelector('.channel-online-count');
          if (countEl) countEl.textContent = `${count} online`;
        }
      }
    }
  }

  toggleMuteChannel(channelId) {
    const gainNode = this.getChannelGain(channelId);
    const isMuted = !this.channelMuted.get(channelId);
    this.channelMuted.set(channelId, isMuted);
    gainNode.gain.value = isMuted ? 0 : 1.0;
    const btn = document.querySelector(`[data-mute-btn="${channelId}"]`);
    if (btn) { btn.classList.toggle('muted', isMuted); btn.textContent = isMuted ? 'MUTED' : 'MUTE'; }
  }

  toggleSoloChannel(channelId) {
    this.soloChannel = this.soloChannel === channelId ? null : channelId;
    document.querySelectorAll('[data-solo-btn]').forEach(btn => {
      btn.classList.toggle('soloed', btn.getAttribute('data-solo-btn') === this.soloChannel);
    });
  }

  setChannelVolume(channelId, volumeVal) {
    this.getChannelGain(channelId).gain.value = parseFloat(volumeVal);
  }

  toggleMasterMute() {
    this.isMutedAll = !this.isMutedAll;
    const btn = document.getElementById('master-mute-btn');
    if (btn) {
      btn.classList.toggle('active', this.isMutedAll);
      btn.textContent = this.isMutedAll ? '🔇 ALL MUTED' : '🔊 AUDIO ACTIVE';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.receiverEngine = new ReceiverEngine();
  window.receiverEngine.init();
});
