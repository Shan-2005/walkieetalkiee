// UI Controller & DOM Manipulation
class UIController {
  constructor() {
    this.wakeLock = null;
    this.toastTimeout = null;
  }

  init() {
    this.requestWakeLock();
  }

  // Prevent mobile screen from sleeping during active walkie-talkie session
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('[UI] Screen Wake Lock acquired.');
      } catch (err) {
        console.warn('[UI] Screen Wake Lock failed:', err.message);
      }
    }
  }

  // Switch between SPA views ('login', 'channelList', 'channelView')
  showScreen(screenId) {
    const screens = ['login-screen', 'channel-list-screen', 'channel-view-screen'];
    screens.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (id === screenId) {
          el.classList.remove('hidden');
          el.classList.add('active');
        } else {
          el.classList.add('hidden');
          el.classList.remove('active');
        }
      }
    });
  }

  // Render all channel cards on Screen 2
  renderChannelGrid() {
    const container = document.getElementById('channel-grid');
    if (!container) return;

    const channels = window.channelManager.getAllChannels();
    container.innerHTML = '';

    channels.forEach(ch => {
      const card = document.createElement('div');
      card.className = `channel-card ${ch.isEmergency ? 'emergency-card' : ch.isBroadcast ? 'broadcast-card' : ''}`;
      card.setAttribute('data-channel-id', ch.id);

      const count = window.channelManager.getMemberCount(ch.id);

      card.innerHTML = `
        <div class="card-header">
          <span class="material-symbols-rounded channel-icon">${ch.icon || 'radio'}</span>
          <span class="member-badge"><i class="badge-dot"></i> ${count} online</span>
        </div>
        <div class="card-body">
          <h3 class="channel-name">${ch.name}</h3>
          <p class="channel-location"><span class="material-symbols-rounded" style="font-size:12px;vertical-align:middle;margin-right:2px;">location_on</span>${ch.location}</p>
          ${ch.date ? `<span class="channel-date"><span class="material-symbols-rounded" style="font-size:11px;vertical-align:middle;margin-right:2px;">calendar_today</span>${ch.date}</span>` : ''}
        </div>
        <div class="card-footer">
          <button class="join-btn">Tap to join</button>
        </div>
      `;

      card.addEventListener('click', () => {
        window.appController.joinChannel(ch.id);
      });

      container.appendChild(card);
    });
  }

  // Render active channel view screen
  renderActiveChannelView(channel) {
    const headerTitle = document.getElementById('active-channel-title');
    const headerIcon = document.getElementById('active-channel-icon');
    const headerLocation = document.getElementById('active-channel-location');
    const channelThemeBar = document.getElementById('channel-theme-bar');

    if (headerTitle) headerTitle.textContent = channel.name;
    if (headerIcon) headerIcon.textContent = channel.icon || 'radio';
    if (headerLocation) headerLocation.textContent = channel.location;
    if (channelThemeBar) channelThemeBar.style.backgroundColor = channel.color;

    this.updatePTTState('idle');
  }

  // Update member count badge & member list
  updateMemberList(members, channelId) {
    const countEl = document.getElementById('active-member-count');
    const listEl = document.getElementById('member-avatars');

    if (countEl) {
      countEl.textContent = `${members.length}`;
    }

    if (listEl) {
      listEl.innerHTML = '';
      members.forEach(m => {
        const avatar = document.createElement('div');
        avatar.className = 'user-avatar';
        avatar.title = `${m.name} (${m.role})`;
        
        // Initials
        const initials = m.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        avatar.textContent = initials;
        
        listEl.appendChild(avatar);
      });
    }
  }

  // Update PTT Button & Speaker visual state
  updatePTTState(state, extraInfo = '') {
    const btn = document.getElementById('ptt-button');
    const statusText = document.getElementById('ptt-status-text');
    const waveform = document.getElementById('audio-waveform');
    const speakerIndicator = document.getElementById('speaker-indicator');
    const speakerName = document.getElementById('speaker-name');

    if (!btn || !statusText) return;

    // Reset classes
    btn.classList.remove('state-requesting', 'state-transmitting', 'state-receiving', 'state-blocked');
    waveform.classList.add('hidden');
    speakerIndicator.classList.add('hidden');

    switch (state) {
      case 'idle':
        statusText.textContent = 'ontouchstart' in window
          ? 'Press Volume Up to Toggle or Tap Button'
          : 'Hold Volume Up or Press to Talk';
        statusText.style.color = '#808080';
        break;

      case 'requesting':
        btn.classList.add('state-requesting');
        statusText.textContent = 'Connecting mic...';
        statusText.style.color = '#808080';
        break;

      case 'transmitting':
        btn.classList.add('state-transmitting');
        statusText.textContent = 'TRANSMITTING';
        statusText.style.color = '#E24B4A';
        waveform.classList.remove('hidden');
        break;

      case 'receiving':
        btn.classList.add('state-receiving');
        statusText.textContent = `${extraInfo} is talking`;
        statusText.style.color = '#00FF85';
        speakerIndicator.classList.remove('hidden');
        if (speakerName) speakerName.textContent = extraInfo;
        waveform.classList.remove('hidden');
        break;

      case 'blocked':
        btn.classList.add('state-blocked');
        statusText.textContent = `Floor busy — ${extraInfo}`;
        statusText.style.color = '#4A4A4A';
        break;
    }
  }

  // Toast Notification banner
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconName = 'info';
    if (type === 'warning') iconName = 'warning';
    if (type === 'error') iconName = 'error';

    toast.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px;">${iconName}</span>
      <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

window.uiController = new UIController();
