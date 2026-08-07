const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const os = require('os');
const selfsigned = require('selfsigned');
require('dotenv').config();

const app = express();
const useHttps = process.env.USE_HTTPS === 'true';
let server;

if (useHttps) {
  const attrs = [{ name: 'commonName', value: 'robofest-walkie-talkie' }];
  const pems = selfsigned.generate(attrs, { days: 365 });
  server = https.createServer({
    key: pems.private,
    cert: pems.cert
  }, app);
  console.log('🔒 HTTPS Mode: Auto-generated self-signed SSL certificate.');
} else {
  server = http.createServer(app);
  console.log('🔓 HTTP Mode: Running standard unsecured connection.');
}

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB limit for binary audio payloads
});

app.use(cors());

// Keep-alive health check route to prevent Render sleep mode
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Robofest 2.0 Walkie-Talkie',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Serve static files with custom headers to prevent browser caching of HTML files
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    if (ext === '.html') {
      // HTML files must always revalidate
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // Allow short caching for other assets (which are version-busted via query params)
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
  }
}));

// Data structures
const users = new Map();
const channels = new Map();
const floorOwner = new Map();
const floorTimers = new Map(); // channelId -> { maxTimer, idleTimer }

function releaseFloor(channelId, socketId = null, reason = 'released') {
  const currentOwner = floorOwner.get(channelId);
  if (!currentOwner) return;

  // Only release if socketId matches OR if force-releasing (socketId === null)
  if (!socketId || currentOwner === socketId) {
    floorOwner.delete(channelId);

    if (floorTimers.has(channelId)) {
      const timers = floorTimers.get(channelId);
      clearTimeout(timers.maxTimer);
      clearTimeout(timers.idleTimer);
      floorTimers.delete(channelId);
    }

    const user = currentOwner ? users.get(currentOwner) : null;
    const releasePayload = {
      channelId,
      socketId: currentOwner,
      userName: user ? user.name : 'User',
      reason
    };

    io.to(channelId).emit('ptt:released', releasePayload);
    console.log(`[Floor Released] Channel: ${channelId} (owner: ${currentOwner}, reason: ${reason})`);
  }
}

function grantFloor(channelId, socketId, mimeType) {
  floorOwner.set(channelId, socketId);
  const user = users.get(socketId);

  // Maximum single transmission duration: 15 seconds limit
  const maxTimer = setTimeout(() => {
    console.log(`[Floor Watchdog] Channel ${channelId} reached 15s max transmission limit.`);
    releaseFloor(channelId, socketId, 'max_duration');
  }, 15000);

  // Audio chunk idle watchdog: 3 seconds without audio chunks auto-releases floor
  const idleTimer = setTimeout(() => {
    console.log(`[Floor Watchdog] Channel ${channelId} idle (no audio chunks for 3s).`);
    releaseFloor(channelId, socketId, 'audio_idle');
  }, 3000);

  floorTimers.set(channelId, { maxTimer, idleTimer });

  const activePayload = {
    channelId,
    userId: socketId,
    userName: user ? user.name : 'Speaker',
    role: user ? user.role : 'Team Member',
    mimeType: mimeType || ''
  };

  io.to(channelId).emit('ptt:active', activePayload);
  console.log(`[Floor Granted] ${user ? user.name : socketId} on ${channelId}`);
}

function touchFloorAudioActivity(channelId, socketId) {
  if (floorOwner.get(channelId) === socketId && floorTimers.has(channelId)) {
    const timers = floorTimers.get(channelId);
    clearTimeout(timers.idleTimer);
    timers.idleTimer = setTimeout(() => {
      console.log(`[Floor Watchdog] Channel ${channelId} idle (no audio chunks for 3s).`);
      releaseFloor(channelId, socketId, 'audio_idle');
    }, 3000);
  }
}

function getChannelMembers(channelId) {
  const memberSockets = channels.get(channelId) || new Set();
  const memberList = [];
  for (const sId of memberSockets) {
    const u = users.get(sId);
    if (u && !u.isReceiver) {
      memberList.push({
        id: sId,
        name: u.name,
        role: u.role,
        channel: u.channel
      });
    }
  }
  return memberList;
}

function broadcastStats() {
  const channelCounts = {};
  for (const [chId, socketSet] of channels.entries()) {
    let count = 0;
    for (const sId of socketSet) {
      const u = users.get(sId);
      if (u && !u.isReceiver) count++;
    }
    channelCounts[chId] = count;
  }
  
  let totalUsers = 0;
  for (const u of users.values()) {
    if (!u.isReceiver) totalUsers++;
  }

  io.emit('stats:update', {
    totalOnline: totalUsers,
    channelCounts
  });
}

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on('user:join', (payload, callback) => {
    const { name, role } = payload || {};
    const userName = (name && name.trim()) ? name.trim() : `User-${socket.id.substring(0, 4)}`;
    const userRole = (role && role.trim()) ? role.trim() : 'Team Member';

    users.set(socket.id, {
      id: socket.id,
      name: userName,
      role: userRole,
      channel: null,
      isReceiver: false,
      joinedAt: Date.now()
    });

    console.log(`[User Joined] ${userName} (${userRole}) [${socket.id}]`);

    if (typeof callback === 'function') {
      callback({
        status: 'ok',
        userId: socket.id,
        user: users.get(socket.id)
      });
    }

    broadcastStats();
  });

  socket.on('receiver:subscribe', (payload, callback) => {
    const { name } = payload || {};
    const receiverName = name || 'Mobile Receiver Station';

    users.set(socket.id, {
      id: socket.id,
      name: receiverName,
      role: 'Mobile Receiver',
      channel: 'all_subscribed',
      isReceiver: true,
      joinedAt: Date.now()
    });

    const allChannelIds = ['all', 'drone', 'war', 'soccer1v1', 'soccer2v2', 'lfr', 'obsrace', 'sumo', 'expo', 'boat'];
    allChannelIds.forEach(chId => {
      socket.join(chId);
    });

    console.log(`[Receiver Subscribed] ${receiverName} listening on all channels [${socket.id}]`);

    if (typeof callback === 'function') {
      callback({
        status: 'ok',
        userId: socket.id,
        subscribedChannels: allChannelIds
      });
    }

    broadcastStats();
  });

  socket.on('channel:join', ({ channelId }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const oldChannel = user.channel;
    if (oldChannel && oldChannel !== 'all_subscribed') {
      socket.leave(oldChannel);
      if (channels.has(oldChannel)) {
        channels.get(oldChannel).delete(socket.id);
        if (floorOwner.get(oldChannel) === socket.id) {
          releaseFloor(oldChannel, socket.id, 'channel_switch');
        }
      }
      io.to(oldChannel).emit('channel:members', {
        channelId: oldChannel,
        members: getChannelMembers(oldChannel)
      });
    }

    user.channel = channelId;
    socket.join(channelId);

    if (!channels.has(channelId)) {
      channels.set(channelId, new Set());
    }
    channels.get(channelId).add(socket.id);

    console.log(`[Channel Join] ${user.name} joined channel: ${channelId}`);

    io.to(channelId).emit('channel:members', {
      channelId,
      members: getChannelMembers(channelId)
    });

    // Verify current floor holder is active
    const currentFloorHolder = floorOwner.get(channelId);
    let floorInfo = null;
    if (currentFloorHolder) {
      const holderUser = users.get(currentFloorHolder);
      if (holderUser) {
        floorInfo = {
          userId: currentFloorHolder,
          userName: holderUser.name,
          role: holderUser.role
        };
      } else {
        // Stale owner — clean up
        releaseFloor(channelId, currentFloorHolder, 'stale_owner_on_join');
      }
    }

    socket.emit('channel:joined', {
      channelId,
      members: getChannelMembers(channelId),
      floorActive: !!floorOwner.get(channelId),
      floorHolder: floorInfo
    });

    broadcastStats();
  });

  socket.on('channel:leave', () => {
    const user = users.get(socket.id);
    if (!user || !user.channel) return;

    const channelId = user.channel;
    if (channelId !== 'all_subscribed') {
      socket.leave(channelId);

      if (channels.has(channelId)) {
        channels.get(channelId).delete(socket.id);
        if (floorOwner.get(channelId) === socket.id) {
          releaseFloor(channelId, socket.id, 'channel_leave');
        }
      }

      user.channel = null;

      io.to(channelId).emit('channel:members', {
        channelId,
        members: getChannelMembers(channelId)
      });
    }

    broadcastStats();
  });

  socket.on('ptt:request', ({ channelId, mimeType }) => {
    const user = users.get(socket.id);
    if (!user) {
      return socket.emit('ptt:denied', { reason: 'User not registered' });
    }

    const targetChannel = channelId || user.channel;
    if (!targetChannel) {
      return socket.emit('ptt:denied', { reason: 'No active channel' });
    }

    let currentOwner = floorOwner.get(targetChannel);

    // Stale owner verification: if current owner socket is disconnected or not in channel, force release!
    if (currentOwner) {
      const ownerSocket = io.sockets.sockets.get(currentOwner);
      const ownerUser = users.get(currentOwner);
      if (!ownerSocket || !ownerSocket.connected || !ownerUser || ownerUser.channel !== targetChannel) {
        console.log(`[Floor Stale] Cleaning stale owner ${currentOwner} on channel ${targetChannel}`);
        releaseFloor(targetChannel, currentOwner, 'stale_owner_cleaned');
        currentOwner = null;
      }
    }

    if (!currentOwner || currentOwner === socket.id) {
      socket.emit('ptt:granted', { channelId: targetChannel });
      grantFloor(targetChannel, socket.id, mimeType);
    } else {
      const ownerUser = users.get(currentOwner);
      const ownerName = ownerUser ? ownerUser.name : 'Someone';
      socket.emit('ptt:denied', {
        channelId: targetChannel,
        currentSpeaker: ownerName,
        reason: `${ownerName} is currently speaking.`
      });
    }
  });

  socket.on('ptt:release', ({ channelId }) => {
    const user = users.get(socket.id);
    const targetChannel = channelId || (user ? user.channel : null);
    if (!targetChannel) return;

    if (floorOwner.get(targetChannel) === socket.id) {
      releaseFloor(targetChannel, socket.id, 'user_released');
    }
  });

  socket.on('audio:chunk', ({ channelId, audioData, mimeType }) => {
    const user = users.get(socket.id);
    if (!user || !audioData) return;

    const targetChannel = channelId || user.channel;
    if (!targetChannel) return;

    touchFloorAudioActivity(targetChannel, socket.id);

    const chunkPayload = {
      channelId: targetChannel,
      senderId: socket.id,
      senderName: user.name,
      senderRole: user.role,
      mimeType: mimeType || '',
      audioData
    };

    socket.to(targetChannel).emit('audio:chunk', chunkPayload);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const userChannel = user.channel;

      if (userChannel && userChannel !== 'all_subscribed' && channels.has(userChannel)) {
        channels.get(userChannel).delete(socket.id);
        if (floorOwner.get(userChannel) === socket.id) {
          releaseFloor(userChannel, socket.id, 'disconnect');
        }

        io.to(userChannel).emit('channel:members', {
          channelId: userChannel,
          members: getChannelMembers(userChannel)
        });
      }

      users.delete(socket.id);
      broadcastStats();
    }
  });
});

// Helper to get Wi-Fi / LAN IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1') {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`====================================================`);
  console.log(`🎙️ Robofest 2.0 Walkie-Talkie Server Running!`);
  console.log(`   📱 Mobile PWA Walkie App : ${protocol}://${localIP}:${PORT}`);
  console.log(`   🎧 Mobile Receiver Station: ${protocol}://${localIP}:${PORT}/receiver.html`);
  console.log(`   💻 Local Desktop Access  : ${protocol}://localhost:${PORT}/receiver.html`);
  if (useHttps) {
    console.log(`   ⚠️ Note: Since this uses a self-signed SSL cert, your`);
    console.log(`     phone will show a warning. Click "Advanced" -> "Proceed"`);
  }
  console.log(`====================================================`);
});
