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
  roundStartOffset: 0,
  roundTurnOrder: [],  // rotated active player IDs for current round
  nextRoundStartId: null, // loser of last round starts next
  // Rundenmodus
  roundMode: false,
  currentRound: 1,  // 1 | 2 | 'final'
  roundLosers: [],  // [{id, name}, ...]
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
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isSpectator: p.isSpectator, guessedCorrect: p.guessedCorrect || false })),
    hostId: getPlayers().find(p => p.isHost)?.id || null,
  });
}

function broadcastCheckState() {
  io.emit('game:checkUpdate', {
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isChecked: p.isChecked, isSpectator: p.isSpectator, guessedCorrect: p.guessedCorrect || false })),
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

  const lastLoser = state.roundLosers.length > 0 ? state.roundLosers[state.roundLosers.length - 1] : null;
  io.emit('game:phaseChange', {
    phase: 'loading',
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isSpectator: p.isSpectator, guessedCorrect: p.guessedCorrect || false })),
    roundMode: state.roundMode,
    currentRound: state.currentRound,
    lastLoserName: lastLoser?.name || null,
  });
}

function startGuessing() {
  state.phase = 'guessing';
  state.turnIndex = 0;
  const total = getActive().reduce((sum, p) => sum + (p.coinsLoaded || 0), 0);
  console.log(`Münzen gesamt: ${total}`);

  // Loser of last round starts; otherwise rotate
  const active = getActive();
  let offset = state.roundStartOffset % active.length;
  if (state.nextRoundStartId) {
    const idx = active.findIndex(p => p.id === state.nextRoundStartId);
    if (idx !== -1) offset = idx;
  }
  state.nextRoundStartId = null;
  const rotated = [...active.slice(offset), ...active.slice(0, offset)];
  state.roundTurnOrder = rotated.map(p => p.id);
  state.roundStartOffset = (offset + 1) % active.length;

  io.emit('game:phaseChange', {
    phase: 'guessing',
    turnOrder: rotated.map(p => ({ id: p.id, name: p.name })),
  });

  advanceTurn();
}

function advanceTurn() {
  const activeIds = new Set(getActive().map(p => p.id));
  const remaining = state.roundTurnOrder
    .map(id => state.players.get(id))
    .filter(p => p && activeIds.has(p.id) && p.guess === null);
  if (remaining.length === 0) { doReveal(); return; }

  const current = remaining[0];

  // If last player: forbid the number if all previous guesses are identical
  let forbiddenNumber = null;
  if (remaining.length === 1) {
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
    if (p) { p.isSpectator = true; p.guessedCorrect = true; }
  });

  const remaining = getActive().length;

  // Animationsdauer berechnen (gleiche Logik wie Client)
  const nonSpectEntries = Object.values(coinsPerPlayer).filter(d => !d.isSpectator);
  const animMs = 1100
    + Math.max(0, nonSpectEntries.length - 1) * 1000
    + nonSpectEntries.reduce((s, d) => s + (d.coins || 0), 0) * 500
    + 200;
  const revealShowMs = animMs + 3000; // Animation + 3s lesen

  state.phase = 'reveal';
  io.emit('game:reveal', { coinsPerPlayer, totalCoins, correctGuessers, loserIds, remaining });

  if (remaining <= 1) {
    const loser = getActive()[0] || null;
    if (loser) {
      state.nextRoundStartId = loser.id;
      state.roundLosers.push({ id: loser.id, name: loser.name });
    }

    if (state.roundMode && state.currentRound !== 'final') {
      // Runde 1 → Runde 2, oder Runde 2 → Endspiel
      setTimeout(() => {
        for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
        if (state.currentRound === 1) {
          state.currentRound = 2;
          startLoading();
        } else {
          // Endspiel: nur die zwei Rundenverlierer spielen
          state.currentRound = 'final';
          state.nextRoundStartId = state.roundLosers[0].id; // Verlierer Runde 1 rät zuerst
          const loserIds = new Set(state.roundLosers.map(l => l.id));
          for (const p of state.players.values()) {
            if (!loserIds.has(p.id)) p.isSpectator = true;
          }
          startLoading();
        }
      }, revealShowMs);
    } else {
      setTimeout(() => {
        state.phase = 'finished';
        io.emit('game:finished', { loserId: loser?.id || null, loserName: loser?.name || '?' });
        setTimeout(() => {
          for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
          state.roundStartOffset = 0;
          state.nextRoundStartId = null;
          state.roundMode = false;
          state.currentRound = 1;
          state.roundLosers = [];
          state.phase = 'lobby';
          broadcastLobby();
          io.emit('game:backToLobby');
        }, 5000);
      }, revealShowMs);
    }
  } else {
    setTimeout(() => startLoading(), revealShowMs);
  }
}

// ─── Socket Events ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('player:join', ({ name }) => {
    if (!name || name.trim() === '') return;
    const player = createPlayer(socket.id, name.trim());
    if (state.phase !== 'lobby') player.isSpectator = true;
    state.players.set(socket.id, player);
    state.joinOrder.push(socket.id);
    console.log(`${player.name} joined (host: ${player.isHost}, spectator: ${player.isSpectator})`);
    if (state.phase === 'lobby') {
      broadcastLobby();
    } else {
      // Only update the new spectator, don't disturb the running game
      socket.emit('lobby:update', {
        players: getPlayers().map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isSpectator: p.isSpectator, guessedCorrect: p.guessedCorrect || false })),
        hostId: getPlayers().find(p => p.isHost)?.id || null,
      });
    }
  });

  socket.on('host:startGame', ({ roundMode } = {}) => {
    const player = state.players.get(socket.id);
    if (!player?.isHost) return;
    if (state.players.size < 2) return;
    for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
    state.roundMode = !!roundMode;
    state.currentRound = 1;
    state.roundLosers = [];
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

    // Must be their turn (use rotated round order)
    const activeIds = new Set(getActive().map(p => p.id));
    const remaining = state.roundTurnOrder
      .map(id => state.players.get(id))
      .filter(p => p && activeIds.has(p.id) && p.guess === null);
    if (!remaining.length || remaining[0].id !== socket.id) return;

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
