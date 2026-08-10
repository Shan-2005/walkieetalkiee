// Robofest 2.0 Receiver Command Center — WebRTC Audio Engine
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
      this.logTerminal('[SYSTEM] Mobile Audio Engine Activated');
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
      const { channelId, userName, role } = data;
      this.logTerminal(`[PTT START] <span class="active-talk">${channelId.toUpperCase()}</span> :: ${userName} (${role})`, 'active-talk');
      this.setChannelSpeakerUI(channelId, userName, true);
    });

    this.socket.on('ptt:released', (data) => {
      const { channelId, userName, socketId } = data;
      this.logTerminal(`[PTT STOP] ${channelId.toUpperCase()} :: ${userName || 'User'} released floor`, 'release-talk');
      this.setChannelSpeakerUI(channelId, null, false);
      if (window.webrtcManager) window.webrtcManager.closePeer(socketId, 'inbound');
    });

    // WebRTC Signaling Events
    this.socket.on('signal:offer', (data) => {
      if (window.webrtcManager) {
        window.webrtcManager.handleOffer(data);
      }
    });

    this.socket.on('signal:answer', (data) => {
      if (window.webrtcManager) {
        window.webrtcManager.handleAnswer(data);
      }
    });

    this.socket.on('signal:ice-candidate', (data) => {
      if (window.webrtcManager) {
        window.webrtcManager.handleIceCandidate(data);
      }
    });
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
        gradient.addColorStop(0, '#D71921');
        gradient.addColorStop(1, '#FFFFFF');
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
      if (speakerTag) {
        const nameEl = speakerTag.querySelector('.speaker-tag-name');
        if (nameEl) {
          nameEl.textContent = ` ${speakerName}`;
        } else {
          speakerTag.textContent = ` ${speakerName}`;
        }
        speakerTag.style.display = 'inline-block';
      }
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
      btn.innerHTML = this.isMutedAll 
        ? '<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">volume_off</span> ALL MUTED'
        : '<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">volume_up</span> AUDIO ACTIVE';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.receiverEngine = new ReceiverEngine();
  window.receiverEngine.init();
});
