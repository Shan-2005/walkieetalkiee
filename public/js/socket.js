// Socket.IO Connection & WebRTC Signaling Manager
class SocketManager {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.currentUserId = null;
    this.listeners = new Map();
  }

  connect() {
    if (this.socket) return;
    
    // Connect to server origin
    this.socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.currentUserId = this.socket.id;
      console.log('[Socket] Connected to server:', this.socket.id);

      // Seamless auto-reconnect on mobile Wi-Fi / cellular drops
      if (this.lastUser) {
        this.socket.emit('user:join', this.lastUser, () => {
          if (this.lastChannel) {
            this.socket.emit('channel:join', { channelId: this.lastChannel });
          }
        });
      }

      this.emitLocal('connect', { userId: this.socket.id });
    });

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      console.warn('[Socket] Disconnected:', reason);
      if (window.pttController) window.pttController.stopPTT();
      if (window.webrtcManager) window.webrtcManager.closeAll();
      this.emitLocal('disconnect', { reason });
    });

    this.socket.on('stats:update', (data) => {
      window.channelManager.updateStats(data);
      this.emitLocal('stats:update', data);
    });

    this.socket.on('channel:members', (data) => {
      this.emitLocal('channel:members', data);
    });

    this.socket.on('channel:joined', (data) => {
      this.emitLocal('channel:joined', data);
    });

    this.socket.on('ptt:granted', (data) => {
      this.emitLocal('ptt:granted', data);
    });

    this.socket.on('ptt:denied', (data) => {
      this.emitLocal('ptt:denied', data);
    });

    this.socket.on('ptt:active', (data) => {
      this.emitLocal('ptt:active', data);
    });

    this.socket.on('ptt:released', (data) => {
      this.emitLocal('ptt:released', data);
    });

    // WebRTC Signaling Listeners
    this.socket.on('signal:offer', (data) => {
      this.emitLocal('signal:offer', data);
    });

    this.socket.on('signal:answer', (data) => {
      this.emitLocal('signal:answer', data);
    });

    this.socket.on('signal:ice-candidate', (data) => {
      this.emitLocal('signal:ice-candidate', data);
    });

    // Socket.IO Voice Binary Audio Stream Listener (College Wi-Fi Relay)
    this.socket.on('audio:stream', (data) => {
      this.emitLocal('audio:stream', data);
    });
  }

  joinUser(name, role, callback) {
    this.lastUser = { name, role };
    if (!this.socket) this.connect();
    this.socket.emit('user:join', { name, role }, callback);
  }

  joinChannel(channelId) {
    this.lastChannel = channelId;
    if (this.socket) {
      this.socket.emit('channel:join', { channelId });
    }
  }

  leaveChannel() {
    if (this.socket) {
      this.socket.emit('channel:leave');
    }
  }

  requestPTT(channelId, mimeType) {
    if (this.socket) {
      this.socket.emit('ptt:request', { channelId, mimeType: mimeType || '' });
    }
  }

  releasePTT(channelId) {
    if (this.socket) {
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

  // Local event emitter pattern
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
