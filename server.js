const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ────────────────────────────────────────────────────────────────

const state = {
  phase: 'lobby',   // lobby | loading | guessing | reveal | finished
  players: new Map(),
  joinOrder: [],    // socketIds in join order — fixed for the whole game
  turnIndex: 0,
};

function createPlayer(id, name) {
  return {
    id,
    name,
    isHost: state.players.size === 0,
    coinsLoaded: null,
    isChecked: false,   // checkbox ticked
    guess: null,
    isSpectator: false,
  };
}

function getPlayers()  { return Array.from(state.players.values()); }
function getActive()   { return state.joinOrder.map(id => state.players.get(id)).filter(p => p && !p.isSpectator); }

function broadcastLobby() {
  io.emit('lobby:update', {
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
    hostId: getPlayers().find(p => p.isHost)?.id || null,
  });
}

function broadcastCheckState() {
  io.emit('game:checkUpdate', {
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isChecked: p.isChecked, isSpectator: p.isSpectator })),
  });
}

// ─── Phase Transitions ─────────────────────────────────────────────────────────

function startLoading() {
  state.phase = 'loading';

  for (const p of state.players.values()) {
    p.coinsLoaded = null;
    p.isChecked = false;
    p.guess = null;
  }

  io.emit('game:phaseChange', {
    phase: 'loading',
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isSpectator: p.isSpectator })),
  });
}

function startGuessing() {
  state.phase = 'guessing';
  state.turnIndex = 0;
  const total = getActive().reduce((sum, p) => sum + (p.coinsLoaded || 0), 0);
  console.log(`Münzen gesamt: ${total}`);

  // Turn order = join order, skip spectators
  const active = getActive();

  io.emit('game:phaseChange', {
    phase: 'guessing',
    turnOrder: active.map(p => ({ id: p.id, name: p.name })),
  });

  advanceTurn();
}

function advanceTurn() {
  const active = getActive().filter(p => p.guess === null);
  if (active.length === 0) { doReveal(); return; }

  const current = active[0];

  // If last player: forbid the number if all previous guesses are identical
  let forbiddenNumber = null;
  if (active.length === 1) {
    const previous = getActive().filter(p => p.guess !== null).map(p => p.guess);
    if (previous.length > 0 && previous.every(g => g === previous[0])) {
      forbiddenNumber = previous[0];
    }
  }

  io.emit('game:turnStart', { playerId: current.id, playerName: current.name, forbiddenNumber });
}

function doReveal() {
  const active = getActive();
  const coinsPerPlayer = {};
  for (const p of state.players.values()) {
    coinsPerPlayer[p.id] = { name: p.name, coins: p.coinsLoaded, guess: p.guess, isSpectator: p.isSpectator };
  }

  const totalCoins = active.reduce((sum, p) => sum + (p.coinsLoaded || 0), 0);
  const correctGuessers = active.filter(p => p.guess === totalCoins).map(p => p.id);
  const loserIds = active.filter(p => p.guess !== totalCoins).map(p => p.id);

  // Eliminate correct guessers
  correctGuessers.forEach(id => {
    const p = state.players.get(id);
    if (p) p.isSpectator = true;
  });

  const remaining = getActive().length;

  state.phase = 'reveal';
  io.emit('game:reveal', { coinsPerPlayer, totalCoins, correctGuessers, loserIds, remaining });

  if (remaining <= 1) {
    const loser = getActive()[0] || null;
    setTimeout(() => {
      state.phase = 'finished';
      io.emit('game:finished', { loserId: loser?.id || null, loserName: loser?.name || '?' });
    }, 1500);
  }
}

// ─── Socket Events ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('player:join', ({ name }) => {
    if (!name || name.trim() === '') return;
    const player = createPlayer(socket.id, name.trim());
    state.players.set(socket.id, player);
    state.joinOrder.push(socket.id);
    console.log(`${player.name} joined (host: ${player.isHost})`);
    broadcastLobby();
  });

  socket.on('host:startGame', () => {
    const player = state.players.get(socket.id);
    if (!player?.isHost) return;
    if (state.players.size < 2) return;
    for (const p of state.players.values()) p.isSpectator = false;
    startLoading();
  });

  // Player locks in coins + ticks checkbox
  socket.on('player:check', ({ coins }) => {
    if (state.phase !== 'loading') return;
    const player = state.players.get(socket.id);
    if (!player || player.isChecked || player.isSpectator) return;

    const c = parseInt(coins);
    if (isNaN(c) || c < 0 || c > 3) return;

    player.coinsLoaded = c;
    player.isChecked = true;

    broadcastCheckState();

    // All active players checked → start guessing
    const active = getActive();
    if (active.length > 0 && active.every(p => p.isChecked)) {
      startGuessing();
    }
  });

  // Player submits their guess (only on their turn)
  socket.on('player:guess', ({ number }) => {
    if (state.phase !== 'guessing') return;
    const player = state.players.get(socket.id);
    if (!player || player.isSpectator || player.guess !== null) return;

    // Must be their turn
    const active = getActive().filter(p => p.guess === null);
    if (!active.length || active[0].id !== socket.id) return;

    const g = parseInt(number);
    if (isNaN(g) || g < 0) return;

    // Forbidden number check
    const stillGuessing = getActive().filter(p => p.guess === null);
    if (stillGuessing.length === 1) {
      const previous = getActive().filter(p => p.guess !== null).map(p => p.guess);
      if (previous.length > 0 && previous.every(v => v === previous[0]) && g === previous[0]) return;
    }

    player.guess = g;
    io.emit('game:guessSubmitted', { playerId: socket.id, playerName: player.name, guess: g });

    advanceTurn();
  });

  socket.on('host:nextRound', () => {
    const player = state.players.get(socket.id);
    if (!player?.isHost || state.phase !== 'reveal') return;
    startLoading();
  });

  socket.on('host:resetGame', () => {
    const player = state.players.get(socket.id);
    if (!player?.isHost) return;
    for (const p of state.players.values()) p.isSpectator = false;
    startLoading();
  });

  socket.on('disconnect', () => {
    const player = state.players.get(socket.id);
    if (!player) return;
    console.log(`${player.name} disconnected`);
    state.players.delete(socket.id);
    state.joinOrder = state.joinOrder.filter(id => id !== socket.id);

    if (player.isHost && state.players.size > 0) {
      state.players.values().next().value.isHost = true;
    }

    if (state.phase === 'lobby') { broadcastLobby(); return; }

    const active = getActive();
    if (active.length <= 1) {
      const loser = active[0] || null;
      state.phase = 'finished';
      io.emit('game:finished', { loserId: loser?.id || null, loserName: loser?.name || '?' });
      return;
    }

    if (state.phase === 'loading') {
      broadcastCheckState();
      if (active.every(p => p.isChecked)) startGuessing();
    } else if (state.phase === 'guessing') {
      advanceTurn();
    }
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = 8080;
server.listen(PORT, () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('─────────────────────────────────');
  console.log(`  Lokal:   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Netzwerk: http://${ip}:${PORT}`));
  console.log('─────────────────────────────────');
});
