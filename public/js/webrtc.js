// WebRTC Manager — Star Topology P2P Real-Time Audio Engine
class WebRTCManager {
  constructor() {
    this.outboundPeers = new Map(); // targetSocketId -> RTCPeerConnection
    this.inboundPeers = new Map();  // senderSocketId -> RTCPeerConnection
    this.audioElements = new Map(); // senderSocketId -> HTMLAudioElement
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

  // ─── TRANSMITTING (Broadcaster) ─────────────────────────────────────────────
  async startBroadcast(channelId, micStream, listenerIds = []) {
    this.closeAll();
    this.localStream = micStream;

    console.log(`[WebRTC] Starting broadcast to ${listenerIds.length} listeners on channel: ${channelId}`);

    for (const listenerId of listenerIds) {
      if (!listenerId) continue;
      try {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        this.outboundPeers.set(listenerId, pc);

        // Add local mic audio tracks
        micStream.getAudioTracks().forEach(track => {
          pc.addTrack(track, micStream);
        });

        // Send ICE candidates to target listener
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            window.socketManager.sendSignal('signal:ice-candidate', {
              targetId: listenerId,
              candidate: event.candidate
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC Outbound] Connection state with ${listenerId}: ${pc.iceConnectionState}`);
        };

        // Create SDP Offer
        const offer = await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        // Send offer via signaling
        window.socketManager.sendSignal('signal:offer', {
          targetId: listenerId,
          offer
        });

      } catch (err) {
        console.error(`[WebRTC] Error creating outbound connection to ${listenerId}:`, err);
      }
    }
  }

  async handleAnswer({ senderId, answer }) {
    const pc = this.outboundPeers.get(senderId);
    if (!pc) {
      console.warn(`[WebRTC] No outbound peer connection found for answer from ${senderId}`);
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[WebRTC] Remote SDP Answer set for listener ${senderId}`);
    } catch (err) {
      console.error(`[WebRTC] Error setting remote answer for ${senderId}:`, err);
    }
  }

  // ─── RECEIVING (Listener) ──────────────────────────────────────────────────
  async handleOffer({ senderId, offer }) {
    console.log(`[WebRTC] Received offer from broadcaster: ${senderId}`);

    // Clean up existing inbound peer for this sender if any
    if (this.inboundPeers.has(senderId)) {
      this.closePeer(senderId, 'inbound');
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.inboundPeers.set(senderId, pc);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          window.socketManager.sendSignal('signal:ice-candidate', {
            targetId: senderId,
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        console.log(`[WebRTC Inbound] Received remote audio track from ${senderId}`);
        const stream = event.streams[0] || new MediaStream([event.track]);
        this.playRemoteStream(senderId, stream);
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC Inbound] Connection state with ${senderId}: ${pc.iceConnectionState}`);
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

  // ─── ICE CANDIDATE EXCHANGE ─────────────────────────────────────────────
  async handleIceCandidate({ senderId, candidate }) {
    if (!candidate) return;
    const iceCandidate = new RTCIceCandidate(candidate);

    const outboundPc = this.outboundPeers.get(senderId);
    if (outboundPc) {
      try {
        await outboundPc.addIceCandidate(iceCandidate);
      } catch (err) {
        console.warn(`[WebRTC Outbound] Error adding ICE candidate from ${senderId}:`, err);
      }
    }

    const inboundPc = this.inboundPeers.get(senderId);
    if (inboundPc) {
      try {
        await inboundPc.addIceCandidate(iceCandidate);
      } catch (err) {
        console.warn(`[WebRTC Inbound] Error adding ICE candidate from ${senderId}:`, err);
      }
    }
  }

  // ─── PLAYBACK HELPERS ─────────────────────────────────────────────────────
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
      console.warn(`[WebRTC] Autoplay blocked for stream ${senderId}:`, err);
    });
  }

  // ─── TEARDOWN & CLEANUP ──────────────────────────────────────────────────
  closePeer(senderOrTargetId, direction = 'all') {
    if (direction === 'all' || direction === 'outbound') {
      const pc = this.outboundPeers.get(senderOrTargetId);
      if (pc) {
        pc.close();
        this.outboundPeers.delete(senderOrTargetId);
      }
    }

    if (direction === 'all' || direction === 'inbound') {
      const pc = this.inboundPeers.get(senderOrTargetId);
      if (pc) {
        pc.close();
        this.inboundPeers.delete(senderOrTargetId);
      }
      const audioEl = this.audioElements.get(senderOrTargetId);
      if (audioEl) {
        audioEl.srcObject = null;
        audioEl.remove();
        this.audioElements.delete(senderOrTargetId);
      }
    }
  }

  closeAll() {
    this.outboundPeers.forEach((pc) => pc.close());
    this.outboundPeers.clear();

    this.inboundPeers.forEach((pc) => pc.close());
    this.inboundPeers.clear();

    this.audioElements.forEach((audioEl) => {
      audioEl.srcObject = null;
      audioEl.remove();
    });
    this.audioElements.clear();

    this.localStream = null;
    console.log('[WebRTC] All peer connections closed.');
  }
}

window.webrtcManager = new WebRTCManager();
