// Main Application Controller & Orchestration
class AppController {
  constructor() {
    this.user = null;
    this.currentChannel = null;
    this.deferredPrompt = null;
  }

  init() {
    console.log('[App] Initializing Robofest 2.0 Walkie-Talkie App...');

    // Register Service Worker for PWA support
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('[PWA] ServiceWorker registered with scope:', reg.scope);
      }).catch((err) => {
        console.warn('[PWA] ServiceWorker registration failed:', err);
      });
    }

    // Capture PWA beforeinstallprompt event
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      console.log('[PWA] beforeinstallprompt event captured');
      const installModal = document.getElementById('pwa-install-modal');
      if (installModal && !sessionStorage.getItem('pwa_dismissed')) {
        installModal.classList.remove('hidden');
      }
    });

    window.uiController.init();
    this.loadSavedProfile();
    this.bindEvents();
    this.setupSocketListeners();
  }

  loadSavedProfile() {
    try {
      const saved = localStorage.getItem('rf_user_profile');
      if (saved) {
        const { name, role } = JSON.parse(saved);
        const nameInput = document.getElementById('user-name-input');
        const roleSelect = document.getElementById('user-role-select');
        if (nameInput && name) nameInput.value = name;
        if (roleSelect && role) roleSelect.value = role;
        console.log('[Profile] Restored saved profile:', name, role);
      }
    } catch (e) {
      console.warn('[Profile] Error loading saved profile:', e);
    }
  }

  saveProfile(name, role) {
    try {
      localStorage.setItem('rf_user_profile', JSON.stringify({ name, role }));
      console.log('[Profile] Saved profile:', name, role);
    } catch (e) {
      console.warn('[Profile] Error saving profile:', e);
    }
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

        // Save profile locally
        this.saveProfile(name, role);

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

            // Update avatar initials
            const avatarEl = document.getElementById('display-user-avatar');
            if (avatarEl) {
              const initials = this.user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
              avatarEl.textContent = initials;
            }

            window.uiController.showToast(`Welcome, ${this.user.name}!`, 'info');
            window.uiController.renderChannelGrid();
            window.uiController.showScreen('channel-list-screen');
          }
        });
      });
    }

    // 2. Back to Channels Button (channel-view-screen only)
    const backBtn = document.getElementById('channel-back-btn');
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

    // 5. Transport Mode Dropdown Event
    const transportSelect = document.getElementById('transport-mode-select');
    if (transportSelect) {
      transportSelect.value = window.pttController.transportMode || 'socket';
      transportSelect.addEventListener('change', (e) => {
        window.pttController.setTransportMode(e.target.value);
        const labels = {
          'socket': 'College Wi-Fi Relay Mode (Socket.IO)',
          'webrtc': 'Direct P2P Mode (WebRTC)',
          'auto': 'Auto Hybrid Mode'
        };
        window.uiController.showToast(`Switched to ${labels[e.target.value] || e.target.value}`, 'info');
      });
    }

    // 6. PWA Install Modal Events
    const pwaInstallBtn = document.getElementById('pwa-install-btn');
    const pwaDismissBtn = document.getElementById('pwa-dismiss-btn');
    const pwaHeaderBtn = document.getElementById('pwa-install-header-btn');

    if (pwaInstallBtn) {
      pwaInstallBtn.addEventListener('click', async () => {
        const installModal = document.getElementById('pwa-install-modal');
        if (installModal) installModal.classList.add('hidden');
        if (this.deferredPrompt) {
          this.deferredPrompt.prompt();
          const choice = await this.deferredPrompt.userChoice;
          console.log('[PWA] User choice:', choice.outcome);
          this.deferredPrompt = null;
        } else {
          window.uiController.showToast('To install: Tap browser menu (⋮ or Share) -> Add to Home Screen', 'info');
        }
      });
    }

    if (pwaDismissBtn) {
      pwaDismissBtn.addEventListener('click', () => {
        const installModal = document.getElementById('pwa-install-modal');
        if (installModal) installModal.classList.add('hidden');
        sessionStorage.setItem('pwa_dismissed', 'true');
      });
    }

    if (pwaHeaderBtn) {
      pwaHeaderBtn.addEventListener('click', () => {
        const installModal = document.getElementById('pwa-install-modal');
        if (installModal) installModal.classList.remove('hidden');
      });
    }

    // 7. Edit Profile Modal Events
    const editProfileBtn = document.getElementById('edit-profile-btn');
    const editModal = document.getElementById('edit-profile-modal');
    const closeEditBtn = document.getElementById('close-edit-modal-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-profile-btn');
    const editForm = document.getElementById('edit-profile-form');

    if (editProfileBtn && editModal) {
      editProfileBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('edit-user-name-input');
        const roleSelect = document.getElementById('edit-user-role-select');
        if (nameInput && this.user) nameInput.value = this.user.name;
        if (roleSelect && this.user) roleSelect.value = this.user.role;
        editModal.classList.remove('hidden');
      });
    }

    const closeEditModal = () => {
      if (editModal) editModal.classList.add('hidden');
    };

    if (closeEditBtn) closeEditBtn.addEventListener('click', closeEditModal);
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditModal);

    if (editForm) {
      editForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const newName = document.getElementById('edit-user-name-input').value.trim();
        const newRole = document.getElementById('edit-user-role-select').value;

        if (!newName) {
          window.uiController.showToast('Please enter a valid name.', 'warning');
          return;
        }

        this.user = { ...this.user, name: newName, role: newRole };
        this.saveProfile(newName, newRole);

        // Update Socket.IO user join state
        window.socketManager.joinUser(newName, newRole, () => {
          if (this.currentChannel) {
            window.socketManager.joinChannel(this.currentChannel.id);
          }
        });

        // Update UI
        document.getElementById('display-user-name').textContent = newName;
        document.getElementById('display-user-role').textContent = newRole;
        const avatarEl = document.getElementById('display-user-avatar');
        if (avatarEl) {
          const initials = newName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
          avatarEl.textContent = initials;
        }

        closeEditModal();
        window.uiController.showToast('Profile updated successfully!', 'info');
      });
    }
  }

  setupSocketListeners() {
    window.socketManager.on('stats:update', () => {
      window.uiController.renderChannelGrid();
    });

    window.socketManager.on('channel:joined', (data) => {
      window.uiController.updateMemberList(data.members, data.channelId);
      if (window.webrtcManager) {
        window.webrtcManager.syncPeers(data.members);
      }

      if (data.floorActive && data.floorHolder) {
        window.pttController.onFloorActive();
        window.uiController.updatePTTState('receiving', data.floorHolder.userName);
      }
    });

    window.socketManager.on('channel:members', (data) => {
      if (this.currentChannel && data.channelId === this.currentChannel.id) {
        window.uiController.updateMemberList(data.members, data.channelId);
        if (window.webrtcManager) {
          window.webrtcManager.syncPeers(data.members);
        }
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
        if (data.isEmergency || data.channelId === 'all' || (this.currentChannel && data.channelId === this.currentChannel.id)) {
          window.pttController.onFloorActive();
          const speakerText = (data.isEmergency || data.channelId === 'all') ? `[!] EMERGENCY: ${data.userName}` : data.userName;
          window.uiController.updatePTTState('receiving', speakerText);
          window.audioEngine.playBeep('start');

          if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            new Notification('Robofest 2.0 Walkie-Talkie', {
              body: `${speakerText} (${data.role}) is broadcasting across ${data.channelId.toUpperCase()}`,
              icon: '/assets/walkie-icon.png'
            });
          }
        }
      }
    });

    window.socketManager.on('ptt:released', (data) => {
      if (data.socketId !== window.socketManager.currentUserId) {
        if (data.isEmergency || data.channelId === 'all' || (this.currentChannel && data.channelId === this.currentChannel.id)) {
          window.pttController.onFloorReleased();
          window.uiController.updatePTTState('idle');
          window.audioEngine.playBeep('stop');
          if ((data.isEmergency || data.channelId === 'all') && window.webrtcManager) {
            window.webrtcManager.closeDynamicPeer(data.socketId);
          }
        }
      }
    });

    // WebRTC Signaling Handlers
    window.socketManager.on('signal:offer', (data) => {
      if (window.webrtcManager) {
        window.webrtcManager.handleOffer(data);
      }
    });

    window.socketManager.on('signal:answer', (data) => {
      if (window.webrtcManager) {
        window.webrtcManager.handleAnswer(data);
      }
    });

    window.socketManager.on('signal:ice-candidate', (data) => {
      if (window.webrtcManager) {
        window.webrtcManager.handleIceCandidate(data);
      }
    });

    // Socket.IO Voice Relay Audio Handler (College Wi-Fi AP Isolation Fallback)
    window.socketManager.on('audio:stream', (data) => {
      if (data.senderId !== window.socketManager.currentUserId) {
        if (data.channelId === 'all' || (this.currentChannel && data.channelId === this.currentChannel.id)) {
          if (window.audioEngine) {
            window.audioEngine.playAudioChunk(data.chunk);
          }
        }
      }
    });
  }

  joinChannel(channelId) {
    const channel = window.channelManager.setActiveChannel(channelId);
    if (!channel) return;

    this.currentChannel = channel;
    window.pttController.setChannel(channelId);

    // Re-trigger/ensure volume probe is active on channel join user gesture
    window.pttController.activateVolumeProbe();

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
