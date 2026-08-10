// WebRTC Manager — Star Topology P2P Hybrid Warm/Dynamic Audio Engine
class WebRTCManager {
  constructor() {
    this.peers = new Map();             // channel members (warm mesh)
    this.dynamicPeers = new Map();      // emergency & receiver temporary connections
    this.audioElements = new Map();     // peerSocketId -> HTMLAudioElement
    this.localStream = null;

    // Default public STUN servers
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ];
  }

  setTurnServers(turnConfig) {
    if (turnConfig && Array.isArray(turnConfig)) {
      this.iceServers = [...this.iceServers, ...turnConfig];
      console.log('[WebRTC] Custom TURN servers added:', turnConfig);
    }
  }

  // Ensure we have a local mic stream ready (tracks muted by default)
  async ensureLocalStream() {
    if (this.localStream && this.localStream.active) return this.localStream;
    try {
      const stream = await window.audioEngine.requestMicPermission();
      // Mute tracks by default
      stream.getAudioTracks().forEach(track => {
        track.enabled = false;
      });
      this.localStream = stream;
      console.log('[WebRTC] Local stream initialized and muted by default.');
      return stream;
    } catch (err) {
      console.error('[WebRTC] Failed to get local stream:', err);
      throw err;
    }
  }

  // Enable/disable transmission of microphone audio
  setMute(isMuted) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
        console.log(`[WebRTC] Local track ${track.id} enabled state: ${track.enabled}`);
      });
    } else {
      console.warn('[WebRTC] Cannot set mute state: No local stream initialized.');
    }
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
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
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
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
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
    await this.ensureLocalStream();
    
    // Enable our local microphone track to start transmitting audio
    this.setMute(false);

    console.log(`[WebRTC] Starting dynamic broadcast to ${listenerIds.length} listeners`);

    for (const peerId of listenerIds) {
      if (!peerId) continue;
      
      // If we already have a warm channel connection, we don't need a temporary one
      if (this.peers.has(peerId)) {
        console.log(`[WebRTC] Using existing warm connection for ${peerId}`);
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
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
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
      pc.close();
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
      pc.close();
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
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();

    this.dynamicPeers.forEach((pc) => pc.close());
    this.dynamicPeers.clear();

    this.audioElements.forEach((audioEl) => {
      audioEl.srcObject = null;
      audioEl.remove();
    });
    this.audioElements.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    console.log('[WebRTC] All connections closed.');
  }
}

window.webrtcManager = new WebRTCManager();
