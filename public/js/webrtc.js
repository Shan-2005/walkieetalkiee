// WebRTC Manager — Star Topology P2P Hybrid Warm/Dynamic Audio Engine
class WebRTCManager {
  constructor() {
    this.peers = new Map();             // channel members (warm mesh)
    this.dynamicPeers = new Map();      // emergency & receiver temporary connections
    this.audioElements = new Map();     // peerSocketId -> HTMLAudioElement
    this.localStream = null;
    this.rawMicStream = null;
    this.localStreamPromise = null;

    // Web Audio Nodes for foolproof hardware muting
    this.audioCtx = null;
    this.micSourceNode = null;
    this.micGainNode = null;
    this.micDestinationNode = null;

    // Broadcast session guard — prevents overlapping broadcasts
    this._broadcastActive = false;
    this._broadcastId = 0;

    // Default public STUN & TURN servers for College Wi-Fi / AP Isolation fallback
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelay', credential: 'openrelay' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelay', credential: 'openrelay' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelay', credential: 'openrelay' }
    ];
  }

  setTurnServers(turnConfig) {
    if (turnConfig && Array.isArray(turnConfig)) {
      this.iceServers = [...this.iceServers, ...turnConfig];
      console.log('[WebRTC] Custom TURN servers added:', turnConfig);
    }
  }

  // Ensure we have a local mic stream ready (tracks routed via GainNode set to 0)
  async ensureLocalStream() {
    if (this.localStream && this.localStream.active) return this.localStream;
    if (this.localStreamPromise) return this.localStreamPromise;

    this.localStreamPromise = (async () => {
      try {
        const rawStream = await window.audioEngine.requestMicPermission();
        
        const audioCtx = window.audioEngine.initAudioContext();
        this.audioCtx = audioCtx;

        // Clean up previous nodes if any
        if (this.micSourceNode) { try { this.micSourceNode.disconnect(); } catch(_) {} }
        if (this.micGainNode) { try { this.micGainNode.disconnect(); } catch(_) {} }

        // Route microphone through Web Audio GainNode for absolute mute security
        this.micSourceNode = audioCtx.createMediaStreamSource(rawStream);
        this.micGainNode = audioCtx.createGain();
        this.micGainNode.gain.value = 0.0; // Muted by default (absolute silence)

        this.micDestinationNode = audioCtx.createMediaStreamDestination();
        
        this.micSourceNode.connect(this.micGainNode);
        this.micGainNode.connect(this.micDestinationNode);

        this.localStream = this.micDestinationNode.stream;
        this.rawMicStream = rawStream;

        console.log('[WebRTC] Web Audio mic routing initialized. Muted by default.');
        this.localStreamPromise = null;
        return this.localStream;
      } catch (err) {
        this.localStreamPromise = null;
        console.error('[WebRTC] Failed to get local stream:', err);
        throw err;
      }
    })();

    return this.localStreamPromise;
  }

  // Enable/disable transmission of microphone audio using Web Audio Gain
  setMute(isMuted) {
    if (this.micGainNode && this.audioCtx) {
      // CRITICAL: Resume AudioContext first if suspended (mobile browsers suspend it on background)
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().then(() => {
          console.log('[WebRTC] AudioContext resumed from suspended state.');
          this._applyGain(isMuted);
        });
      } else {
        this._applyGain(isMuted);
      }
    } else {
      console.warn('[WebRTC] Cannot set mute state: Web Audio nodes not initialized.');
    }
  }

  _applyGain(isMuted) {
    if (!this.micGainNode || !this.audioCtx) return;
    const targetVal = isMuted ? 0.0 : 1.0;
    // Smooth 10ms exponential ramp to prevent audio pops and clicks
    try {
      this.micGainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.micGainNode.gain.setTargetAtTime(targetVal, this.audioCtx.currentTime, 0.01);
    } catch (e) {
      // Fallback: set directly
      this.micGainNode.gain.value = targetVal;
    }
    console.log(`[WebRTC] Web Audio mic gain set to: ${targetVal}`);
  }

  // Sync connections with the current list of channel members
  async syncPeers(members) {
    await this.ensureLocalStream();

    const myId = window.socketManager.currentUserId;
    if (!myId) return;

    const activeIds = new Set(members.map(m => m.id).filter(id => id !== myId));

    // 1. Clean up stale connections
    for (const [peerId, pc] of this.peers.entries()) {
      if (!activeIds.has(peerId)) {
        console.log(`[WebRTC] Peer ${peerId} left. Closing connection.`);
        this.closePeer(peerId);
      }
    }

    // 2. Establish new connections
    for (const peerId of activeIds) {
      if (!this.peers.has(peerId)) {
        // Lexicographical comparison to ensure only one peer offers
        if (myId > peerId) {
          console.log(`[WebRTC] Initiating peer connection to ${peerId}`);
          this.initiateConnection(peerId);
        } else {
          console.log(`[WebRTC] Waiting for peer ${peerId} to initiate connection.`);
        }
      }
    }
  }

  async initiateConnection(peerId) {
    if (this.peers.has(peerId)) return;

    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.peers.set(peerId, pc);

      // Add local tracks (muted)
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          pc.addTrack(track, this.localStream);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          window.socketManager.sendSignal('signal:ice-candidate', {
            targetId: peerId,
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        console.log(`[WebRTC] Received remote track from ${peerId}`);
        const stream = event.streams[0] || new MediaStream([event.track]);
        this.playRemoteStream(peerId, stream);
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] Connection with ${peerId} state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          if (window.pttController) window.pttController.notifyICEFailure();
          this.closePeer(peerId);
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false
      });
      await pc.setLocalDescription(offer);

      window.socketManager.sendSignal('signal:offer', {
        targetId: peerId,
        offer
      });

    } catch (err) {
      console.error(`[WebRTC] Error initiating connection to ${peerId}:`, err);
    }
  }

  async handleOffer({ senderId, offer }) {
    console.log(`[WebRTC] Received offer from ${senderId}`);
    
    // Determine if this is a temporary dynamic peer or a regular channel peer.
    // If they are not in our warm channel mesh, it's a dynamic broadcast.
    const isDynamic = !this.peers.has(senderId);

    try {
      await this.ensureLocalStream();

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      if (isDynamic) {
        // Clean up existing dynamic peer if any
        if (this.dynamicPeers.has(senderId)) {
          this.closeDynamicPeer(senderId);
        }
        this.dynamicPeers.set(senderId, pc);
      } else {
        // Clean up existing warm peer if any
        if (this.peers.has(senderId)) {
          this.closePeer(senderId);
        }
        this.peers.set(senderId, pc);
      }

      // Receivers do not need to send audio back for dynamic/one-way broadcasts
      if (!isDynamic && this.localStream) {
        this.localStream.getTracks().forEach(track => {
          pc.addTrack(track, this.localStream);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          window.socketManager.sendSignal('signal:ice-candidate', {
            targetId: senderId,
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        console.log(`[WebRTC] Received remote track from ${senderId}`);
        const stream = event.streams[0] || new MediaStream([event.track]);
        this.playRemoteStream(senderId, stream);
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] Connection with ${senderId} state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          if (window.pttController) window.pttController.notifyICEFailure();
          if (isDynamic) {
            this.closeDynamicPeer(senderId);
          } else {
            this.closePeer(senderId);
          }
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      window.socketManager.sendSignal('signal:answer', {
        targetId: senderId,
        answer
      });

    } catch (err) {
      console.error(`[WebRTC] Error handling offer from ${senderId}:`, err);
    }
  }

  async handleAnswer({ senderId, answer }) {
    const pc = this.peers.get(senderId) || this.dynamicPeers.get(senderId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[WebRTC] Connection established with ${senderId}`);
    } catch (err) {
      console.error(`[WebRTC] Error setting remote answer for ${senderId}:`, err);
    }
  }

  async handleIceCandidate({ senderId, candidate }) {
    const pc = this.peers.get(senderId) || this.dynamicPeers.get(senderId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn(`[WebRTC] Error adding ICE candidate from ${senderId}:`, err);
    }
  }

  // ─── DYNAMIC BROADCAST (Emergency / Receiver) ─────────────────────────────
  async startBroadcast(listenerIds) {
    // Increment broadcast session ID — any previous in-flight broadcasts become stale
    const sessionId = ++this._broadcastId;

    try {
      await this.ensureLocalStream();
    } catch (err) {
      console.error('[WebRTC] Cannot start broadcast — mic unavailable:', err);
      return;
    }

    // Check if this broadcast session is still current
    if (sessionId !== this._broadcastId) {
      console.log('[WebRTC] Broadcast session superseded — aborting.');
      return;
    }

    // Mark broadcast as active
    this._broadcastActive = true;
    
    // Enable our local microphone track to start transmitting audio
    this.setMute(false);

    // Verify the mic stream is still alive (can die on mobile if user revoked permission)
    if (this.rawMicStream && !this.rawMicStream.active) {
      console.warn('[WebRTC] Raw mic stream is dead — re-acquiring.');
      this.localStream = null;
      this.rawMicStream = null;
      this.localStreamPromise = null;
      try {
        await this.ensureLocalStream();
        this.setMute(false);
      } catch (err) {
        console.error('[WebRTC] Failed to re-acquire mic:', err);
        this._broadcastActive = false;
        return;
      }
    }

    console.log(`[WebRTC] Starting dynamic broadcast to ${listenerIds.length} listeners`);

    for (const peerId of listenerIds) {
      if (!peerId) continue;
      
      // Abort if broadcast was cancelled while we're iterating
      if (sessionId !== this._broadcastId || !this._broadcastActive) {
        console.log('[WebRTC] Broadcast cancelled mid-setup — stopping peer creation.');
        break;
      }

      // If we already have a warm channel connection, we don't need a temporary one
      if (this.peers.has(peerId)) {
        console.log(`[WebRTC] Using existing warm connection for ${peerId}`);
        continue;
      }

      // Skip if we already have a dynamic connection to this peer
      if (this.dynamicPeers.has(peerId)) {
        console.log(`[WebRTC] Already have dynamic connection to ${peerId} — skipping.`);
        continue;
      }

      try {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        this.dynamicPeers.set(peerId, pc);

        if (this.localStream) {
          this.localStream.getTracks().forEach(track => {
            pc.addTrack(track, this.localStream);
          });
        }

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            window.socketManager.sendSignal('signal:ice-candidate', {
              targetId: peerId,
              candidate: event.candidate
            });
          }
        };

        pc.ontrack = (event) => {
          const stream = event.streams[0] || new MediaStream([event.track]);
          this.playRemoteStream(peerId, stream);
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed') {
            if (window.pttController) window.pttController.notifyICEFailure();
            this.closeDynamicPeer(peerId);
          }
        };

        const offer = await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        window.socketManager.sendSignal('signal:offer', {
          targetId: peerId,
          offer
        });

      } catch (err) {
        console.error(`[WebRTC] Error starting dynamic connection to ${peerId}:`, err);
      }
    }
  }

  stopBroadcast() {
    // Invalidate any in-flight broadcast sessions
    this._broadcastId++;
    this._broadcastActive = false;

    // Mute local microphone track
    this.setMute(true);

    // Close and remove all temporary dynamic peer connections
    for (const [peerId] of this.dynamicPeers.entries()) {
      this.closeDynamicPeer(peerId);
    }
    console.log('[WebRTC] Broadcast stopped. Dynamic connections closed.');
  }

  playRemoteStream(senderId, stream) {
    let audioEl = this.audioElements.get(senderId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `webrtc-audio-${senderId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      this.audioElements.set(senderId, audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.play().catch(err => {
      console.warn(`[WebRTC] Autoplay blocked for ${senderId}:`, err);
    });
  }

  closePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) {
      try { pc.close(); } catch (_) {}
      this.peers.delete(peerId);
    }
    const audioEl = this.audioElements.get(peerId);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      this.audioElements.delete(peerId);
    }
  }

  closeDynamicPeer(peerId) {
    const pc = this.dynamicPeers.get(peerId);
    if (pc) {
      try { pc.close(); } catch (_) {}
      this.dynamicPeers.delete(peerId);
    }
    const audioEl = this.audioElements.get(peerId);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      this.audioElements.delete(peerId);
    }
  }

  closeAll() {
    // Invalidate any in-flight broadcasts
    this._broadcastId++;
    this._broadcastActive = false;

    this.peers.forEach((pc) => { try { pc.close(); } catch(_) {} });
    this.peers.clear();

    this.dynamicPeers.forEach((pc) => { try { pc.close(); } catch(_) {} });
    this.dynamicPeers.clear();

    this.audioElements.forEach((audioEl) => {
      audioEl.srcObject = null;
      audioEl.remove();
    });
    this.audioElements.clear();

    // Clean up Web Audio routing
    if (this.micSourceNode) {
      try { this.micSourceNode.disconnect(); } catch(_) {}
      this.micSourceNode = null;
    }
    if (this.micGainNode) {
      try { this.micGainNode.disconnect(); } catch(_) {}
      this.micGainNode = null;
    }
    this.micDestinationNode = null;

    if (this.rawMicStream) {
      this.rawMicStream.getTracks().forEach(track => track.stop());
      this.rawMicStream = null;
    }
    this.localStream = null;
    console.log('[WebRTC] All connections and Web Audio nodes cleared.');
  }
}

window.webrtcManager = new WebRTCManager();
