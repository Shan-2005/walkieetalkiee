/**
 * Robofest 2.0 Walkie-Talkie — 9-Channel Concurrent Stress Test
 * 
 * Simulates 27 users (3 per channel × 9 channels), with 1 speaker per channel
 * transmitting simultaneously. Validates signaling throughput, floor control,
 * and concurrent channel handling under peak load.
 * 
 * Usage:
 *   node tests/stress-test.js [serverUrl]
 *   Default: http://localhost:3000
 */

const { io } = require('socket.io-client');

const SERVER_URL = process.argv[2] || 'http://localhost:3000';

const CHANNELS = ['drone', 'war', 'soccer1v1', 'soccer2v2', 'lfr', 'obsrace', 'sumo', 'expo', 'boat'];
const USERS_PER_CHANNEL = 3; // 1 speaker + 2 listeners per channel
const PTT_HOLD_DURATION_MS = 4000; // Each speaker holds PTT for 4 seconds
const STAGGER_DELAY_MS = 200; // Stagger channel activations by 200ms

const stats = {
  connected: 0,
  joinedChannel: 0,
  floorGranted: 0,
  floorDenied: 0,
  floorReleased: 0,
  pttActiveReceived: 0,
  signalOffers: 0,
  signalAnswers: 0,
  iceCandidates: 0,
  errors: 0,
  latencies: [],
};

const clients = [];

function createClient(name, role, channelId, isSpeaker) {
  return new Promise((resolve) => {
    const socket = io(SERVER_URL, {
      reconnection: false,
      transports: ['websocket'],
      timeout: 10000,
    });

    const client = { socket, name, channelId, isSpeaker, connected: false };
    clients.push(client);

    socket.on('connect', () => {
      client.connected = true;
      stats.connected++;
      
      socket.emit('user:join', { name, role }, (res) => {
        if (res && res.status === 'ok') {
          socket.emit('channel:join', { channelId });
        }
      });
    });

    socket.on('channel:joined', () => {
      stats.joinedChannel++;
      resolve(client);
    });

    socket.on('ptt:granted', () => {
      stats.floorGranted++;
    });

    socket.on('ptt:denied', () => {
      stats.floorDenied++;
    });

    socket.on('ptt:active', () => {
      stats.pttActiveReceived++;
    });

    socket.on('ptt:released', () => {
      stats.floorReleased++;
    });

    socket.on('signal:offer', (data) => {
      stats.signalOffers++;
      // Simulate answering the offer (as a listener would)
      if (!isSpeaker) {
        socket.emit('signal:answer', {
          targetId: data.senderId,
          answer: { type: 'answer', sdp: 'mock-sdp-answer' }
        });
        stats.signalAnswers++;
      }
    });

    socket.on('signal:answer', () => {
      stats.signalAnswers++;
    });

    socket.on('signal:ice-candidate', () => {
      stats.iceCandidates++;
    });

    socket.on('connect_error', (err) => {
      stats.errors++;
      console.error(`  ✗ ${name} connection error: ${err.message}`);
      resolve(client);
    });

    setTimeout(() => {
      if (!client.connected) {
        stats.errors++;
        console.error(`  ✗ ${name} connection timeout`);
        resolve(client);
      }
    }, 10000);
  });
}

async function runChannelTest(channelId, channelIndex) {
  const channelClients = [];

  // Create users for this channel
  for (let i = 0; i < USERS_PER_CHANNEL; i++) {
    const isSpeaker = i === 0;
    const roleName = isSpeaker ? 'Speaker' : 'Listener';
    const name = `Bot-${channelId}-${roleName}-${i}`;
    const client = await createClient(name, 'Volunteer', channelId, isSpeaker);
    channelClients.push(client);
  }

  // Stagger activation per channel
  await delay(channelIndex * STAGGER_DELAY_MS);

  // Speaker requests PTT
  const speaker = channelClients[0];
  if (speaker.connected) {
    const requestTime = Date.now();

    // Listen for grant to measure latency
    speaker.socket.once('ptt:granted', () => {
      const latency = Date.now() - requestTime;
      stats.latencies.push({ channel: channelId, latencyMs: latency });

      // Simulate signaling to listeners (send mock offers)
      speaker.socket.emit('channel:get-listeners', { channelId: channelId }, (res) => {
        const listeners = res ? res.listeners : [];
        console.log(`  📡 ${channelId.toUpperCase()} speaker sending offers to ${listeners.length} listeners`);
        
        for (const listenerId of listeners) {
          speaker.socket.emit('signal:offer', {
            targetId: listenerId,
            offer: { type: 'offer', sdp: 'mock-sdp-offer' }
          });

          // Simulate ICE candidates
          for (let c = 0; c < 3; c++) {
            speaker.socket.emit('signal:ice-candidate', {
              targetId: listenerId,
              candidate: { candidate: `mock-candidate-${c}`, sdpMid: '0', sdpMLineIndex: 0 }
            });
          }
        }
      });

      // Hold PTT then release
      setTimeout(() => {
        speaker.socket.emit('ptt:release', { channelId });
      }, PTT_HOLD_DURATION_MS);
    });

    speaker.socket.emit('ptt:request', { channelId, mimeType: '' });
    console.log(`  🎙️  ${channelId.toUpperCase()} — PTT requested`);
  }

  return channelClients;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function printReport() {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   ROBOFEST 2.0 — 9-CHANNEL STRESS TEST REPORT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Server URL        : ${SERVER_URL}`);
  console.log(`   Channels Tested   : ${CHANNELS.length}`);
  console.log(`   Total Bots        : ${CHANNELS.length * USERS_PER_CHANNEL}`);
  console.log(`   PTT Hold Duration : ${PTT_HOLD_DURATION_MS}ms`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`   ✅ Connected      : ${stats.connected}`);
  console.log(`   ✅ Joined Channel : ${stats.joinedChannel}`);
  console.log(`   ✅ Floor Granted  : ${stats.floorGranted}`);
  console.log(`   ❌ Floor Denied   : ${stats.floorDenied}`);
  console.log(`   📢 PTT Active Rcv : ${stats.pttActiveReceived}`);
  console.log(`   🔓 Floor Released : ${stats.floorReleased}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`   📡 Signal Offers  : ${stats.signalOffers}`);
  console.log(`   📡 Signal Answers : ${stats.signalAnswers}`);
  console.log(`   🧊 ICE Candidates : ${stats.iceCandidates}`);
  console.log(`   ❗ Errors         : ${stats.errors}`);
  console.log('───────────────────────────────────────────────────────────');

  if (stats.latencies.length > 0) {
    const latencies = stats.latencies.map(l => l.latencyMs);
    const avg = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    console.log('   FLOOR GRANT LATENCY:');
    console.log(`     Avg: ${avg}ms  |  Min: ${min}ms  |  Max: ${max}ms`);
    console.log('     Per-Channel:');
    stats.latencies.forEach(l => {
      const bar = '█'.repeat(Math.min(Math.round(l.latencyMs / 5), 40));
      console.log(`       ${l.channel.padEnd(10)} : ${l.latencyMs}ms ${bar}`);
    });
  }

  console.log('───────────────────────────────────────────────────────────');

  const allGranted = stats.floorGranted === CHANNELS.length;
  const allReleased = stats.floorReleased >= CHANNELS.length;
  const noErrors = stats.errors === 0;

  if (allGranted && allReleased && noErrors) {
    console.log('   🟢 RESULT: ALL 9 CHANNELS PASSED — SYSTEM IS READY');
  } else if (allGranted && noErrors) {
    console.log('   🟡 RESULT: ALL FLOORS GRANTED — WAITING FOR RELEASES');
  } else {
    console.log('   🔴 RESULT: ISSUES DETECTED — SEE REPORT ABOVE');
  }
  console.log('═══════════════════════════════════════════════════════════\n');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   ROBOFEST 2.0 — 9-CHANNEL CONCURRENT STRESS TEST');
  console.log(`   Target: ${SERVER_URL}`);
  console.log(`   Bots: ${CHANNELS.length * USERS_PER_CHANNEL} (${USERS_PER_CHANNEL}/channel × ${CHANNELS.length} channels)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('[Phase 1] Connecting bots and joining channels...');
  
  const allChannelClients = [];
  for (let i = 0; i < CHANNELS.length; i++) {
    const channelClients = [];
    for (let j = 0; j < USERS_PER_CHANNEL; j++) {
      const isSpeaker = j === 0;
      const name = `Bot-${CHANNELS[i]}-${isSpeaker ? 'SPK' : 'LST' + j}`;
      const client = await createClient(name, 'Volunteer', CHANNELS[i], isSpeaker);
      channelClients.push(client);
    }
    allChannelClients.push(channelClients);
  }
  
  await delay(1000);
  console.log(`  ✅ ${stats.connected} bots connected, ${stats.joinedChannel} joined channels.\n`);

  console.log('[Phase 2] Activating all 9 channels simultaneously...');
  
  const pttPromises = CHANNELS.map(async (channelId, idx) => {
    await delay(idx * STAGGER_DELAY_MS);
    
    const speaker = allChannelClients[idx][0];
    if (!speaker.connected) {
      console.log(`  ✗ ${channelId.toUpperCase()} speaker not connected, skipping`);
      return;
    }

    const requestTime = Date.now();

    return new Promise((resolve) => {
      speaker.socket.once('ptt:granted', () => {
        const latency = Date.now() - requestTime;
        stats.latencies.push({ channel: channelId, latencyMs: latency });
        console.log(`  🎙️  ${channelId.toUpperCase().padEnd(10)} GRANTED (${latency}ms)`);

        // Simulate signaling
        speaker.socket.emit('channel:get-listeners', { channelId }, (res) => {
          const listeners = res ? res.listeners : [];
          for (const lid of listeners) {
            speaker.socket.emit('signal:offer', {
              targetId: lid,
              offer: { type: 'offer', sdp: 'mock-sdp' }
            });
            speaker.socket.emit('signal:ice-candidate', {
              targetId: lid,
              candidate: { candidate: 'mock-ice', sdpMid: '0', sdpMLineIndex: 0 }
            });
          }
        });

        // Hold PTT then release
        setTimeout(() => {
          speaker.socket.emit('ptt:release', { channelId });
          resolve();
        }, PTT_HOLD_DURATION_MS);
      });

      speaker.socket.once('ptt:denied', (data) => {
        console.log(`  ❌ ${channelId.toUpperCase().padEnd(10)} DENIED — ${data.currentSpeaker || 'busy'}`);
        resolve();
      });

      speaker.socket.emit('ptt:request', { channelId, mimeType: '' });
    });
  });

  await Promise.all(pttPromises);
  
  // Wait for releases to propagate
  await delay(PTT_HOLD_DURATION_MS + 2000);

  printReport();

  // Cleanup
  console.log('[Cleanup] Disconnecting all bots...');
  clients.forEach(c => c.socket.disconnect());
  await delay(1000);
  console.log('  ✅ Done.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
