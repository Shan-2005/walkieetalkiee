// Socket.IO Connection & WebRTC Signaling Manager
class SocketManager {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.currentUserId = null;
    this.listeners = new Map();
    this.lastUser = null;
    this.lastChannel = null;
    this._watchdogInterval = null;
    this._listenersRegistered = false; // global events only registered once

    // Start the watchdog immediately — it runs for the lifetime of the page
    this._startWatchdog();
    this._registerGlobalEvents();
  }

  // ─── Internal: register window-level events ONCE ───────────────────────────
  _registerGlobalEvents() {
    window.addEventListener('online', () => {
      console.log('[Socket] Network came online — checking connection...');
      this.checkAndReconnect();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[Socket] Tab/screen visible — checking connection...');
        this.checkAndReconnect();
      }
    });
  }

  // ─── Internal: always-running watchdog, survives reconnects ────────────────
  _startWatchdog() {
    if (this._watchdogInterval) return; // only one watchdog ever
    this._watchdogInterval = setInterval(() => {
      if (!this.lastUser) return; // not logged in yet, nothing to do

      if (!this.socket || !this.socket.connected) {
        console.warn('[Socket Watchdog] Dead socket detected — reconnecting...');
        this.checkAndReconnect();
      } else {
        // Socket alive — send a lightweight keep-alive ping to prevent
        // Wi-Fi router NAT idle-timeout and college network TCP RST drops
        this.socket.emit('ping:keepalive');
      }
    }, 3000);
  }

  // ─── Internal: attach all socket.io event listeners to current socket ──────
  _attachSocketListeners() {
    const s = this.socket;

    s.on('connect', () => {
      this.isConnected = true;
      this.currentUserId = s.id;
      console.log('[Socket] Connected:', s.id);

      // Re-register user + channel after every reconnect
      if (this.lastUser) {
        s.emit('user:join', this.lastUser, () => {
          if (this.lastChannel) {
            s.emit('channel:join', { channelId: this.lastChannel });
          }
        });
      }

      this.emitLocal('connect', { userId: s.id });
    });

    s.on('disconnect', (reason) => {
      this.isConnected = false;
      console.warn('[Socket] Disconnected:', reason);
      if (window.pttController) window.pttController.stopPTT();
      if (window.webrtcManager) window.webrtcManager.closeAll();
      this.emitLocal('disconnect', { reason });
    });

    s.on('connect_error', (err) => {
      console.warn('[Socket] Connection error:', err.message);
    });

    s.on('stats:update', (data) => {
      window.channelManager.updateStats(data);
      this.emitLocal('stats:update', data);
    });

    s.on('channel:members',     (data) => this.emitLocal('channel:members', data));
    s.on('channel:joined',      (data) => this.emitLocal('channel:joined', data));
    s.on('ptt:granted',         (data) => this.emitLocal('ptt:granted', data));
    s.on('ptt:denied',          (data) => this.emitLocal('ptt:denied', data));
    s.on('ptt:active',          (data) => this.emitLocal('ptt:active', data));
    s.on('ptt:released',        (data) => this.emitLocal('ptt:released', data));
    s.on('signal:offer',        (data) => this.emitLocal('signal:offer', data));
    s.on('signal:answer',       (data) => this.emitLocal('signal:answer', data));
    s.on('signal:ice-candidate',(data) => this.emitLocal('signal:ice-candidate', data));
    s.on('audio:stream',        (data) => this.emitLocal('audio:stream', data));
    s.on('pong:keepalive',      ()     => { /* server acknowledged our ping */ });
  }

  // ─── Public: create a brand-new socket and attach listeners ────────────────
  connect() {
    // If an existing socket is alive, just re-verify session
    if (this.socket && this.socket.connected) {
      if (this.lastUser) {
        this.socket.emit('user:join', this.lastUser, () => {
          if (this.lastChannel) {
            this.socket.emit('channel:join', { channelId: this.lastChannel });
          }
        });
      }
      return;
    }

    // Destroy any zombie socket first
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch (_) {}
      try { this.socket.disconnect(); } catch (_) {}
      this.socket = null;
      this.isConnected = false;
    }

    console.log('[Socket] Creating new socket connection...');
    this.socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 10000,
      transports: ['websocket', 'polling']
    });

    // Always attach listeners on every new socket instance
    this._attachSocketListeners();
  }

  // ─── Public: called on wake-up, tab-focus, or network restore ──────────────
  checkAndReconnect() {
    if (!this.lastUser) return;

    if (!this.socket || !this.socket.connected) {
      console.log('[Socket] Zombie/dead socket — rebuilding fresh connection...');
      this.connect();
    } else {
      // Socket is live — re-verify server-side session (user may have been evicted)
      this.socket.emit('user:join', this.lastUser, () => {
        if (this.lastChannel) {
          this.socket.emit('channel:join', { channelId: this.lastChannel });
        }
      });
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  joinUser(name, role, callback) {
    this.lastUser = { name, role };
    if (!this.socket || !this.socket.connected) this.connect();
    this.socket.emit('user:join', { name, role }, callback);
  }

  joinChannel(channelId) {
    this.lastChannel = channelId;
    if (this.socket && this.socket.connected) {
      this.socket.emit('channel:join', { channelId });
    }
  }

  leaveChannel() {
    this.lastChannel = null;
    if (this.socket) this.socket.emit('channel:leave');
  }

  requestPTT(channelId, mimeType) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('ptt:request', { channelId, mimeType: mimeType || '' });
    }
  }

  releasePTT(channelId) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('ptt:release', { channelId });
    }
  }

  sendAudioChunk(channelId, chunk, mimeType) {
    if (this.socket && this.isConnected) {
      this.socket.emit('audio:stream', { channelId, chunk, mimeType });
    }
  }

  getChannelListeners(channelId, callback) {
    if (this.socket) {
      this.socket.emit('channel:get-listeners', { channelId }, callback);
    }
  }

  sendSignal(eventName, payload) {
    if (this.socket && this.isConnected) {
      this.socket.emit(eventName, payload);
    }
  }

  // ─── Local event emitter pattern ───────────────────────────────────────────
  on(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(fn);
  }

  emitLocal(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(fn => fn(data));
    }
  }
}

window.socketManager = new SocketManager();
