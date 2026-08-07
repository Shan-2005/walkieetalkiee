// Channels & Event Dataset from HANDOFF spec
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
    prizePool: '₹1,00,000',
    entryFee: '₹1,000',
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
    prizePool: '₹3,50,000',
    entryFee: '₹4,000',
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
    prizePool: '₹30,000',
    entryFee: '₹600',
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
    prizePool: '₹50,000',
    entryFee: '₹600',
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
    prizePool: '₹30,000',
    entryFee: '₹300',
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
    prizePool: '₹40,000',
    entryFee: '₹400',
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
    prizePool: '₹50,000',
    entryFee: '₹600',
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
    prizePool: '₹25,000',
    entryFee: '₹200',
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
    prizePool: '₹25,000',
    entryFee: '₹200',
    teamSizeMax: 2
  }
];

const ALL_CHANNEL = {
  id: 'all',
  name: 'ALL CHANNELS',
  emoji: '📢',
  color: '#FACC15',
  date: 'BROADCAST',
  location: 'Broadcast to everyone',
  isBroadcast: true
};

class ChannelManager {
  constructor() {
    this.events = EVENTS;
    this.allChannel = ALL_CHANNEL;
    this.activeChannel = null;
    this.channelCounts = {};
    this.totalOnline = 0;
  }

  getAllChannels() {
    return [this.allChannel, ...this.events];
  }

  getChannelById(id) {
    if (id === 'all') return this.allChannel;
    return this.events.find(c => c.id === id) || null;
  }

  setActiveChannel(id) {
    this.activeChannel = this.getChannelById(id);
    return this.activeChannel;
  }

  getActiveChannel() {
    return this.activeChannel;
  }

  updateStats(stats) {
    this.totalOnline = stats.totalOnline || 0;
    this.channelCounts = stats.channelCounts || {};
  }

  getMemberCount(channelId) {
    return this.channelCounts[channelId] || 0;
  }
}

window.channelManager = new ChannelManager();
