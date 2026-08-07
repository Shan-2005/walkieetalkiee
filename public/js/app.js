// Main Application Controller & Orchestration
class AppController {
  constructor() {
    this.user = null;
    this.currentChannel = null;
  }

  init() {
    console.log('[App] Initializing Robofest 2.0 Walkie-Talkie App...');
    
    // Unregister any active service workers to prevent caching issues
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (let registration of registrations) {
          registration.unregister().then(() => {
            console.log('[PWA] ServiceWorker unregistered successfully.');
          });
        }
      });
    }

    // Secure context check (logged only, no UI banner)
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      console.warn('[App] Not running in secure context — mic access may be blocked on mobile.');
    }

    window.uiController.init();
    this.bindEvents();
    this.setupSocketListeners();
  }

  bindEvents() {
    // 1. Login Form Submit
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('user-name-input');
        const roleSelect = document.getElementById('user-role-select');

        const name = nameInput ? nameInput.value.trim() : '';
        const role = roleSelect ? roleSelect.value : 'Team Member';

        if (!name) {
          window.uiController.showToast('Please enter your name.', 'warning');
          return;
        }

        // Request browser Notification permission if supported
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission();
        }

        // Unlock audio context on user click gesture
        window.audioEngine.initAudioContext();

        // Activate mobile volume button detection (needs user gesture)
        window.pttController.activateVolumeProbe();

        // Request Mic access early
        window.audioEngine.requestMicPermission().catch((err) => {
          console.warn('[App] Initial mic permission prompt failed:', err);
        });

        // Connect user via Socket.IO
        window.socketManager.joinUser(name, role, (res) => {
          if (res && res.status === 'ok') {
            this.user = res.user;
            document.getElementById('display-user-name').textContent = this.user.name;
            document.getElementById('display-user-role').textContent = this.user.role;

            window.uiController.showToast(`Welcome, ${this.user.name}!`, 'info');
            window.uiController.renderChannelGrid();
            window.uiController.showScreen('channel-list-screen');
          }
        });
      });
    }

    // 2. Back to Channels Button
    const backBtn = document.getElementById('back-to-channels-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        this.leaveCurrentChannel();
      });
    }

    // 3. Attach PTT Button to Controller
    const pttBtn = document.getElementById('ptt-button');
    if (pttBtn) {
      window.pttController.setButtonElement(pttBtn);
    }

    // 4. Toggle Mode Checkbox Event
    const toggleCheckbox = document.getElementById('toggle-mode-checkbox');
    if (toggleCheckbox) {
      toggleCheckbox.addEventListener('change', (e) => {
        window.pttController.setToggleMode(e.target.checked);
      });
    }
  }

  setupSocketListeners() {
    window.socketManager.on('stats:update', () => {
      window.uiController.renderChannelGrid();
    });

    window.socketManager.on('channel:joined', (data) => {
      window.uiController.updateMemberList(data.members, data.channelId);

      if (data.floorActive && data.floorHolder) {
        window.pttController.onFloorActive();
        window.uiController.updatePTTState('receiving', data.floorHolder.userName);
      }
    });

    window.socketManager.on('channel:members', (data) => {
      if (this.currentChannel && data.channelId === this.currentChannel.id) {
        window.uiController.updateMemberList(data.members, data.channelId);
      }
    });

    window.socketManager.on('ptt:granted', () => {
      window.pttController.onFloorGranted();
    });

    window.socketManager.on('ptt:denied', (data) => {
      window.pttController.onFloorDenied(data.currentSpeaker);
    });

    window.socketManager.on('ptt:active', (data) => {
      if (data.userId !== window.socketManager.currentUserId) {
        window.pttController.onFloorActive();
        window.uiController.updatePTTState('receiving', data.userName);
        window.audioEngine.playBeep('start');
        // Init MSE streaming player for the incoming speaker's codec
        window.audioEngine.initMediaSourcePlayer(data.mimeType || '');

        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
          new Notification('Robofest 2.0 Walkie-Talkie', {
            body: `${data.userName} (${data.role}) is talking on ${data.channelId.toUpperCase()}`,
            icon: '/assets/walkie-icon.png'
          });
        }
      }
    });

    window.socketManager.on('ptt:released', (data) => {
      if (data.socketId !== window.socketManager.currentUserId) {
        window.pttController.onFloorReleased();
        window.uiController.updatePTTState('idle');
        window.audioEngine.playBeep('stop');
        // Gracefully end the MSE session
        setTimeout(() => window.audioEngine.teardownPlayer(), 600);
      }
    });

    window.socketManager.on('audio:chunk', (data) => {
      if (data.senderId !== window.socketManager.currentUserId) {
        // Guard: only play audio if we are actively joined in the chunk's channel
        if (this.currentChannel && data.channelId === this.currentChannel.id) {
          window.audioEngine.receiveChunk(data.audioData);
        }
      }
    });
  }

  joinChannel(channelId) {
    const channel = window.channelManager.setActiveChannel(channelId);
    if (!channel) return;

    this.currentChannel = channel;
    window.pttController.setChannel(channelId);

    window.audioEngine.requestMicPermission().catch(() => {
      window.uiController.showToast('Microphone access is needed for Push-to-Talk.', 'warning');
    });

    window.socketManager.joinChannel(channelId);
    window.uiController.renderActiveChannelView(channel);
    window.uiController.showScreen('channel-view-screen');

    window.uiController.showToast('Tip: Hold Volume Up or tap the button to talk.', 'info');
  }

  leaveCurrentChannel() {
    if (this.currentChannel) {
      window.pttController.stopPTT();
      window.socketManager.leaveChannel();
      this.currentChannel = null;
      window.pttController.setChannel(null);
    }
    window.uiController.renderChannelGrid();
    window.uiController.showScreen('channel-list-screen');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.appController = new AppController();
  window.appController.init();
});
