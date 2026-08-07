# Robofest 2.0 — Walkie-Talkie Web App (Full Build Spec)

> **Purpose**: This document is a complete handoff for an agent to build a real-time walkie-talkie PWA for the Robofest 2.0 event organizing team at SRM University.
> **Target**: Mobile-first PWA, optimized for Android Chrome (team members will use phones).

---

## 1. What We're Building

A **push-to-talk (PTT) walkie-talkie** web application for the Robofest 2.0 organizing committee. Team members join channels for their assigned events and communicate via half-duplex voice (one person talks at a time per channel, everyone else hears).

### Core User Flow
1. User opens the app → enters their **name** and **role** (e.g., "Aadarsh — Drone SPOC")
2. User sees a **channel list** → taps to join a channel
3. Inside a channel → **holds Volume Up** (or on-screen PTT button) to talk
4. Audio streams to all other users in the same channel in real-time
5. User can switch channels or join the "All Channels" broadcast channel

---

## 2. Channels (10 Total)

| # | Channel Name     | Color Accent   | Event Date   | Location                      |
|---|------------------|----------------|-------------|-------------------------------|
| 1 | 🚁 Drone         | `#FF6B35`      | 19-08-2026  | Milkha Singh Ground           |
| 2 | ⚔️ War            | `#DC2626`      | 20-08-2026  | Vendhir Square / BB Court     |
| 3 | ⚽ Soccer 1v1     | `#16A34A`      | 19-08-2026  | 702 TP2                       |
| 4 | ⚽ Soccer 2v2     | `#15803D`      | 19-08-2026  | 702 TP2                       |
| 5 | 🤖 LFR           | `#2563EB`      | 19-08-2026  | 712 TP2                       |
| 6 | 🏃 Obs Race      | `#7C3AED`      | 20-08-2026  | Milkha Singh Ground           |
| 7 | 🥊 SUMO          | `#EA580C`      | 20-08-2026  | 702 TP2                       |
| 8 | 🎪 EXPO          | `#0891B2`      | 21-08-2026  | 702 TP2                       |
| 9 | ⛵ Boat           | `#0284C7`      | 21-08-2026  | Fountain opposite TP Ganeshan |
| 10| 📢 ALL CHANNELS  | `#FACC15` gold | —           | Broadcast to everyone         |

### Channel Behavior
- Channels 1–9 are **isolated** — audio only goes to members of that channel.
- Channel 10 ("ALL CHANNELS") is a **broadcast overlay** — when someone talks here, audio reaches **every connected user regardless of their current channel**.
- A user can only be in **one event channel** at a time, but they **always** hear ALL CHANNELS broadcasts.

---

## 3. Push-to-Talk (PTT) Mechanism

### Primary: Hardware Volume Up Button
- Use the `keydown` / `keyup` events for `volumeup` key on Android Chrome.
- On Android WebView/Chrome, `volumeup` fires as a `KeyboardEvent` with `event.key === "AudioVolumeUp"` or `event.code === "AudioVolumeUp"`.
- **On `keydown`** → start capturing mic audio and streaming it.
- **On `keyup`** → stop streaming, release mic.
- **IMPORTANT**: Call `event.preventDefault()` to prevent the system volume from actually changing.
- Some Android devices may not reliably fire these events in the browser. Always provide a fallback.

### Fallback: On-Screen PTT Button
- A large, centered, circular button at the bottom of the channel view.
- **Touch start** (`pointerdown`) → start transmitting.
- **Touch end** (`pointerup`) → stop transmitting.
- Visual states: idle (grey), transmitting (pulsing red/green glow), receiving (subtle animation).

### Half-Duplex Rules
- Only **one person** can transmit on a channel at a time.
- If someone is already transmitting, others see a "🔴 [Name] is talking..." indicator and their PTT is blocked.
- Server manages the "floor" — first to press gets the mic, others are queued/blocked.

---

## 4. Technical Architecture

### Stack
```
Frontend:  Vanilla HTML + CSS + JS (single-page app, NO framework)
Backend:   Node.js + Express + Socket.IO (signaling server)
Audio:     Web Audio API + MediaRecorder for capture, AudioContext for playback
Transport: Socket.IO binary events (audio chunks streamed as ArrayBuffer)
```

### Why NOT WebRTC peer-to-peer?
- WebRTC P2P requires mesh connections (N×N), which is impractical for 10+ users per channel.
- Using a **server-relay model** (SFU-lite): audio chunks are sent to the server via Socket.IO, and the server broadcasts to all channel members. This is simpler, more reliable on campus Wi-Fi, and easier to manage floor control.

### Architecture Diagram
```
┌──────────────┐     Socket.IO      ┌─────────────────┐     Socket.IO      ┌──────────────┐
│  Phone A     │ ──── audio chunks ──→│   Node Server   │──── audio chunks ──→│  Phone B     │
│  (Speaker)   │                     │   (Relay + PTT  │                     │  (Listener)  │
│              │ ←── "floor taken" ──│    Floor Ctrl)  │←── PTT request ────│              │
└──────────────┘                     └─────────────────┘                     └──────────────┘
```

### Data Flow
1. **User presses PTT** → client emits `ptt:request { channel, userId }`
2. **Server checks floor** → if free, emits `ptt:granted { userId }` to requester, `ptt:active { userId, userName }` to all in channel
3. **User speaks** → client captures audio via MediaRecorder in 100ms chunks → emits `audio:chunk { channel, data: ArrayBuffer }`
4. **Server relays** → broadcasts `audio:chunk` to all in that channel (except sender)
5. **Receivers play** → AudioContext decodes and plays chunks in real-time
6. **User releases PTT** → client emits `ptt:release { channel, userId }`
7. **Server frees floor** → emits `ptt:released` to all in channel

---

## 5. File Structure

```
robofest-walkie-talkie/
├── server/
│   ├── package.json
│   ├── server.js            # Express + Socket.IO server
│   └── .env                 # PORT config
├── public/
│   ├── index.html           # Single HTML entry
│   ├── css/
│   │   └── styles.css       # All styles (dark theme, glassmorphism)
│   ├── js/
│   │   ├── app.js           # Main app controller, routing between views
│   │   ├── socket.js        # Socket.IO connection manager
│   │   ├── audio.js         # Mic capture, audio playback engine
│   │   ├── ptt.js           # PTT button + volume key handler
│   │   ├── channels.js      # Channel data, switching logic
│   │   └── ui.js            # DOM manipulation, animations, toasts
│   ├── assets/
│   │   ├── walkie-icon.png  # App icon (generate with generate_image)
│   │   └── sounds/          # PTT beep-on, beep-off (generate or use base64)
│   ├── manifest.json        # PWA manifest
│   └── sw.js                # Service worker for PWA install
└── README.md
```

---

## 6. UI/UX Design Specification

### Theme
- **Dark mode** base (`#0A0A0F` background)
- **Glassmorphism** cards with `backdrop-filter: blur(16px)` and semi-transparent backgrounds
- **Neon accent glows** matching each channel's color
- Font: **Inter** (Google Fonts) or system `-apple-system, BlinkMacSystemFont, 'Segoe UI'`

### Screens

#### Screen 1: Login / Join
- Full-screen dark gradient background with subtle animated radio waves
- App title: "ROBOFEST 2.0 — WALKIE TALKIE" in bold, with a radio icon
- Input fields: **Name**, **Role/Event** (dropdown)
- "Connect" button with gradient and hover glow
- SRM University branding at bottom

#### Screen 2: Channel List
- Grid of 10 channel cards (2 columns on mobile)
- Each card shows: emoji icon, channel name, event date, location, member count (live)
- "ALL CHANNELS" card is visually distinct (gold border, larger)
- Cards have subtle hover/tap animations (scale + glow)
- Top bar: user name, connection status indicator (green dot), settings icon

#### Screen 3: Channel View (Main Walkie-Talkie)
- **Top bar**: Channel name + color, back button, member count
- **Members panel**: Scrollable list of connected users (avatar circle with initials)
- **Activity area**: Shows who is currently talking with a waveform animation
- **PTT Button**: Large circle at bottom center (≥80px), takes up ~30% of screen height
  - **Idle**: Dark with channel-color border
  - **Transmitting**: Pulsing glow in channel color, ripple animation, mic icon changes
  - **Receiving**: Speaker icon pulses, waveform animation shows
  - **Blocked**: Red tint, shows "🔴 [Name] is talking"
- **Status text** below PTT: "Hold to talk" / "Transmitting..." / "Listening..."

### Animations
- Channel cards: `transform: scale(1.02)` on hover, `box-shadow` glow
- PTT button: CSS `@keyframes` pulse (scale 1 → 1.05 → 1), ring ripple expanding outward
- Waveform: CSS animated bars (5 bars, random heights via animation-delay)
- Page transitions: fade-in with slight upward slide (200ms)
- Toast notifications: slide in from top, auto-dismiss after 3s

### Responsive
- Mobile-first (375px–428px primary target)
- Channel grid: 2 columns on mobile, 3 on tablet
- PTT button: fixed to bottom, always accessible
- No horizontal scroll ever

---

## 7. Server Implementation Details

### `server.js` Core Logic

```javascript
// Key data structures
const channels = new Map();      // channelId → Set<socketId>
const users = new Map();          // socketId → { name, role, channel }
const floorOwner = new Map();     // channelId → socketId (who holds the floor)

// Socket events to handle:
// 'user:join'       → { name, role } → store user, emit user list update
// 'channel:join'    → { channelId }  → move user to channel, emit member update
// 'channel:leave'   → leave current channel
// 'ptt:request'     → check floor, grant or deny
// 'ptt:release'     → free floor, notify channel
// 'audio:chunk'     → relay ArrayBuffer to all in channel (except sender)
// 'disconnect'      → cleanup user, free floor if they held it, notify channel

// ALL CHANNELS special handling:
// When audio:chunk comes on channel "all", broadcast to EVERY connected socket
// When someone talks on "all", show indicator on ALL users' screens
```

### Audio Chunk Format
- MediaRecorder with `mimeType: 'audio/webm;codecs=opus'` (best for voice, small size)
- `timeslice: 100` ms (emit a chunk every 100ms for near-real-time)
- Chunks are raw `Blob` → converted to `ArrayBuffer` → sent via Socket.IO binary

### Floor Control Algorithm
```
on ptt:request(channelId, socketId):
  if floorOwner.get(channelId) is null:
    floorOwner.set(channelId, socketId)
    emit 'ptt:granted' to requester
    emit 'ptt:active' { userId, userName } to channel
  else:
    emit 'ptt:denied' { currentSpeaker } to requester

on ptt:release(channelId, socketId):
  if floorOwner.get(channelId) === socketId:
    floorOwner.delete(channelId)
    emit 'ptt:released' to channel
```

---

## 8. Audio Engine Details

### Capture (Transmitting)
```javascript
// 1. getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
// 2. Create MediaRecorder with opus codec
// 3. On dataavailable → emit chunk to server
// 4. On PTT release → recorder.stop(), stream.getTracks().forEach(t => t.stop())
```

### Playback (Receiving)
```javascript
// 1. Maintain an AudioContext (resume on user gesture for autoplay policy)
// 2. On receiving audio:chunk → decode ArrayBuffer with audioContext.decodeAudioData()
// 3. Create BufferSource → connect to destination → play
// 4. Queue chunks to avoid gaps (small buffer of ~200ms)
//
// ALTERNATIVE (simpler): 
// Use MediaSource Extensions (MSE) with an <audio> element
// Or: Accumulate chunks into a Blob URL and play via Audio() — 
//     but this adds latency. Prefer AudioContext for lowest latency.
```

### PTT Beep Sounds
- Generate short beep tones using OscillatorNode (no external files needed)
- "Roger beep" on PTT press (short rising tone, 100ms)
- "Roger out" on PTT release (short falling tone, 100ms)

---

## 9. Volume Button Handling (Critical)

```javascript
// This is the KEY differentiator of this app

document.addEventListener('keydown', (e) => {
  if (e.key === 'AudioVolumeUp' || e.code === 'AudioVolumeUp') {
    e.preventDefault();  // PREVENT system volume change
    e.stopPropagation();
    if (!isPTTActive) {
      startTransmitting();
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'AudioVolumeUp' || e.code === 'AudioVolumeUp') {
    e.preventDefault();
    e.stopPropagation();
    if (isPTTActive) {
      stopTransmitting();
    }
  }
});

// FALLBACK: Some Android devices/browsers don't fire volume key events
// in the browser. In that case, the on-screen PTT button is the primary input.
// Show a toast on first load: "For best experience, use the Volume Up button to talk"
```

---

## 10. PWA Configuration

### `manifest.json`
```json
{
  "name": "Robofest 2.0 Walkie Talkie",
  "short_name": "RF Talkie",
  "description": "Push-to-talk communication for Robofest 2.0 organizing team",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0A0A0F",
  "theme_color": "#FACC15",
  "icons": [
    { "src": "/assets/walkie-icon.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/assets/walkie-icon.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### Service Worker
- Cache the app shell (HTML, CSS, JS) for offline loading
- Audio/socket features obviously require network — show "Offline" indicator when disconnected

---

## 11. Event & Team Data (from spreadsheet)

```javascript
const EVENTS = [
  {
    id: 'drone',
    name: 'Drone',
    emoji: '🚁',
    color: '#FF6B35',
    date: '19-08-2026',
    location: 'Milkha Singh Ground',
    facultySPOC: 'Ida Seraphim, Kandhan',
    studentSPOC: 'Aadarsh, Aadit',
    prizePool: 100000,
    entryFee: 1000,
    teamSizeMax: 3
  },
  {
    id: 'war',
    name: 'War',
    emoji: '⚔️',
    color: '#DC2626',
    date: '20-08-2026',
    location: 'Vendhir Square / BB Court',
    facultySPOC: 'Ashwathy, Shiju, Jishnu',
    studentSPOC: 'Revanth',
    prizePool: 350000,
    entryFee: 4000,
    teamSizeMax: 10
  },
  {
    id: 'soccer1v1',
    name: 'Soccer 1v1',
    emoji: '⚽',
    color: '#16A34A',
    date: '19-08-2026',
    location: '702 TP2',
    facultySPOC: 'Prabhu Shankar',
    studentSPOC: 'Ashwin',
    prizePool: 30000,
    entryFee: 600,
    teamSizeMax: 4
  },
  {
    id: 'soccer2v2',
    name: 'Soccer 2v2',
    emoji: '⚽',
    color: '#15803D',
    date: '19-08-2026',
    location: '702 TP2',
    facultySPOC: 'Prabhu Shankar',
    studentSPOC: 'Shan',
    prizePool: 50000,
    entryFee: 600,
    teamSizeMax: 4
  },
  {
    id: 'lfr',
    name: 'LFR',
    emoji: '🤖',
    color: '#2563EB',
    date: '19-08-2026',
    location: '712 TP2',
    facultySPOC: 'Arun',
    studentSPOC: 'Harish, Keith',
    prizePool: 30000,
    entryFee: 300,
    teamSizeMax: 2
  },
  {
    id: 'obsrace',
    name: 'Obs Race',
    emoji: '🏃',
    color: '#7C3AED',
    date: '20-08-2026',
    location: 'Milkha Singh Ground',
    facultySPOC: 'New Faculty',
    studentSPOC: 'Rithish, Shan',
    prizePool: 40000,
    entryFee: 400,
    teamSizeMax: 3
  },
  {
    id: 'sumo',
    name: 'SUMO',
    emoji: '🥊',
    color: '#EA580C',
    date: '20-08-2026',
    location: '702 TP2',
    facultySPOC: 'Viji',
    studentSPOC: 'Harish',
    prizePool: 50000,
    entryFee: 600,
    teamSizeMax: 4
  },
  {
    id: 'expo',
    name: 'EXPO',
    emoji: '🎪',
    color: '#0891B2',
    date: '21-08-2026',
    location: '702 TP2',
    facultySPOC: 'Lavanya',
    studentSPOC: 'Harshil',
    prizePool: 25000,
    entryFee: 200,
    teamSizeMax: 3
  },
  {
    id: 'boat',
    name: 'Boat',
    emoji: '⛵',
    color: '#0284C7',
    date: '21-08-2026',
    location: 'Fountain opposite TP Ganeshan',
    facultySPOC: 'Vidhyalakshmi',
    studentSPOC: 'Oliver',
    prizePool: 25000,
    entryFee: 200,
    teamSizeMax: 2
  }
];

// Channel 10 — ALL CHANNELS (broadcast)
const ALL_CHANNEL = {
  id: 'all',
  name: 'ALL CHANNELS',
  emoji: '📢',
  color: '#FACC15',
  date: null,
  location: 'Broadcast to everyone'
};
```

---

## 12. Non-Functional Requirements

| Requirement     | Target                                                    |
|-----------------|-----------------------------------------------------------|
| Latency         | < 300ms end-to-end audio (campus Wi-Fi)                   |
| Concurrent users| 30–50 (organizing team size)                              |
| Browser support | Android Chrome 90+ (primary), iOS Safari 15+ (secondary)  |
| Network         | Works on campus Wi-Fi (SRM), fallback over 4G             |
| Install         | PWA installable on Android home screen                    |
| Offline         | App shell loads offline, shows "No connection" for comms  |

---

## 13. Deployment Note

For the event, the server will be run on a laptop on the same campus Wi-Fi:
```bash
cd server
npm install
node server.js
# Serves on http://<laptop-ip>:3000
# Team members open http://<laptop-ip>:3000 on their phones
```

Alternatively, deploy to a free tier (Render, Railway, etc.) for internet access.

---

## 14. Build Checklist for the Agent

- [ ] Initialize Node.js project in `server/`
- [ ] Install dependencies: `express`, `socket.io`
- [ ] Build `server.js` with all socket events, floor control, channel management
- [ ] Create `public/index.html` with all three screen views (login, channels, channel view)
- [ ] Create `public/css/styles.css` — dark glassmorphism theme, animations, responsive
- [ ] Create `public/js/app.js` — main controller, screen navigation
- [ ] Create `public/js/socket.js` — Socket.IO connection and event handlers
- [ ] Create `public/js/audio.js` — mic capture + playback engine
- [ ] Create `public/js/ptt.js` — volume button handler + on-screen PTT button
- [ ] Create `public/js/channels.js` — channel data and switching logic
- [ ] Create `public/js/ui.js` — DOM helpers, toasts, animations
- [ ] Create `manifest.json` and `sw.js` for PWA
- [ ] Generate app icon using generate_image tool
- [ ] Test PTT flow end-to-end
- [ ] Ensure ALL CHANNELS broadcast works correctly
- [ ] Add roger beep sounds via Web Audio API oscillator
- [ ] Polish animations and transitions
- [ ] Verify mobile responsiveness

---

## 15. Key Gotchas & Tips

1. **AudioContext autoplay policy**: Must be resumed after a user gesture (tap). Resume it on the "Connect" button click or first PTT press.
2. **getUserMedia permissions**: Request mic access on channel join, not on page load. Show a helpful prompt.
3. **Volume button on iOS**: iOS Safari does NOT expose volume key events to web pages. On iOS, the on-screen PTT button is the only option. Show a note to iOS users.
4. **MediaRecorder codec**: Use `audio/webm;codecs=opus` — check `MediaRecorder.isTypeSupported()` and fall back to `audio/webm` if needed.
5. **Socket.IO binary**: Send audio chunks as `ArrayBuffer`, not base64 strings. Socket.IO handles binary natively and it's ~33% more efficient.
6. **Floor release on disconnect**: If a user holding the floor disconnects, the server MUST release the floor immediately.
7. **Prevent screen sleep**: Use the Wake Lock API (`navigator.wakeLock.request('screen')`) to keep the phone awake during event use.
8. **Network resilience**: Socket.IO auto-reconnects. On reconnect, re-join the user's channel and update the UI.

---

*This document contains everything needed to build the Robofest 2.0 Walkie-Talkie app. No further clarification needed — just build it.*
