const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DB_FILE = path.join(__dirname, 'Knobel.txt');

function readDB() {
  const lines = fs.readFileSync(DB_FILE, 'utf8').split('\n').filter(l => l.trim());
  return lines.slice(1).map(l => {
    const [name, geburtstag, lieblingsgetraenk] = l.split(',');
    return { name, geburtstag, lieblingsgetraenk };
  });
}

function writeDB(entries) {
  const lines = ['Name,Geburtstag,Lieblingsgetränk',
    ...entries.map(e => `${e.name},${e.geburtstag},${e.lieblingsgetraenk}`)
  ];
  fs.writeFileSync(DB_FILE, lines.join('\n') + '\n', 'utf8');
}

const FRANK_ALIASES = ['frank', 'franky', 'frankie', 'fusch'];
function findDbEntry(db, playerName) {
  const lower = playerName.toLowerCase();
  return db.find(e => e.name.toLowerCase() === lower)
      || (playerName === 'Frank Fischer' ? db.find(e => FRANK_ALIASES.includes(e.name.toLowerCase())) : null);
}

app.get('/api/knobel', (req, res) => res.json(readDB()));

app.post('/api/knobel', (req, res) => {
  const { name, geburtstag, lieblingsgetraenk } = req.body;
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  const entries = readDB();
  entries.push({ name, geburtstag: geburtstag || '', lieblingsgetraenk: lieblingsgetraenk || '' });
  writeDB(entries);
  res.json({ ok: true });
});

app.delete('/api/knobel/:index', (req, res) => {
  const entries = readDB();
  const i = parseInt(req.params.index);
  if (isNaN(i) || i < 0 || i >= entries.length) return res.status(400).json({ error: 'Ungültiger Index' });
  entries.splice(i, 1);
  writeDB(entries);
  res.json({ ok: true });
});

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
  durchgang: 0,     // Durchgang innerhalb einer Hauptrunde (1 = erster)
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

function getYoungestId() {
  try {
    const db = readDB();
    let youngestId = null;
    let youngestDate = null;
    for (const p of state.players.values()) {
      const entry = findDbEntry(db, p.name);
      if (!entry?.geburtstag) continue;
      const [d, m, y] = entry.geburtstag.split('.').map(Number);
      const date = new Date(y, m - 1, d);
      if (!youngestDate || date > youngestDate) {
        youngestDate = date;
        youngestId = p.id;
      }
    }
    return youngestId;
  } catch (e) { return null; }
}

function broadcastLobby() {
  io.emit('lobby:update', {
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isSpectator: p.isSpectator, guessedCorrect: p.guessedCorrect || false })),
    hostId: getPlayers().find(p => p.isHost)?.id || null,
    youngestId: getYoungestId(),
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
  state.durchgang++;

  for (const p of state.players.values()) {
    p.coinsLoaded = null;
    p.isChecked = false;
    p.guess = null;
  }

  io.emit('game:phaseChange', {
    phase: 'loading',
    players: getPlayers().map(p => ({ id: p.id, name: p.name, isSpectator: p.isSpectator, guessedCorrect: p.guessedCorrect || false })),
    roundMode: state.roundMode,
    currentRound: state.currentRound,
    durchgang: state.durchgang,
    roundLoserIds: state.roundLosers.map(l => l.id),
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
    roundMode: state.roundMode,
    currentRound: state.currentRound,
    durchgang: state.durchgang,
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

  // Ausnahmeregel: erster Durchgang, nicht Endspiel → erster Spieler mit 0 Münzen verliert sofort die Runde
  let ruleViolator = null;
  if (state.durchgang === 1 && state.currentRound !== 'final') {
    const first0 = state.joinOrder
      .map(id => state.players.get(id))
      .find(p => p && !p.isSpectator && p.coinsLoaded === 0);
    if (first0) ruleViolator = { id: first0.id, name: first0.name };
  }

  const totalCoins = active.reduce((sum, p) => sum + (p.coinsLoaded || 0), 0);

  // Unmöglicher Tipp: Spieler tippt außerhalb seines möglichen Bereichs
  let impossibleGuesser = null;
  if (!ruleViolator) {
    const activeCount = active.length;
    const minPerOther = (state.durchgang === 1 && state.currentRound !== 'final') ? 1 : 0;
    for (const p of active) {
      const min = p.coinsLoaded + (activeCount - 1) * minPerOther;
      const max = p.coinsLoaded + (activeCount - 1) * 3;
      if (p.guess < min || p.guess > max) {
        impossibleGuesser = { id: p.id, name: p.name };
        break;
      }
    }
  }

  // Regelverstoß hat Vorrang: Sieger-Ermittlung nur wenn kein Verstoß
  let correctGuessers = [];
  let loserIds = active.map(p => p.id);
  if (!ruleViolator && !impossibleGuesser) {
    correctGuessers = active.filter(p => p.guess === totalCoins).map(p => p.id);
    loserIds = active.filter(p => p.guess !== totalCoins).map(p => p.id);

    // Eliminate correct guessers
    correctGuessers.forEach(id => {
      const p = state.players.get(id);
      if (p) { p.isSpectator = true; p.guessedCorrect = true; }
    });
  }

  const remaining = getActive().length;

  // Animationsdauer berechnen (gleiche Logik wie Client)
  const nonSpectEntries = Object.values(coinsPerPlayer).filter(d => !d.isSpectator);
  const animMs = 1100
    + Math.max(0, nonSpectEntries.length - 1) * 1000
    + nonSpectEntries.reduce((s, d) => s + (d.coins || 0), 0) * 500
    + 200;
  const revealShowMs = animMs + 3000; // Animation + 3s lesen

  state.phase = 'reveal';
  io.emit('game:reveal', {
    coinsPerPlayer, totalCoins, correctGuessers, loserIds, remaining,
    ruleViolatorId: ruleViolator?.id || null,
    ruleViolatorName: ruleViolator?.name || null,
    impossibleGuesserId: impossibleGuesser?.id || null,
    impossibleGuesserName: impossibleGuesser?.name || null,
  });

  // Unmöglicher Tipp: Rundenverlierer sofort festlegen
  if (impossibleGuesser) {
    state.roundLosers.push({ id: impossibleGuesser.id, name: impossibleGuesser.name });
    state.nextRoundStartId = impossibleGuesser.id;
    setTimeout(() => {
      for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
      if (state.currentRound === 'final') {
        state.phase = 'finished';
        io.emit('game:finished', { loserId: impossibleGuesser.id, loserName: impossibleGuesser.name, players: getFinishedPlayers(), roundLoserIds: state.roundLosers.map(l => l.id) });
      } else if (state.currentRound === 1) {
        io.emit('game:announcement', { type: 'round1Loser', names: [impossibleGuesser.name] });
        setTimeout(() => { state.currentRound = 2; state.durchgang = 0; startLoading(); }, 5000);
      } else if (state.roundLosers[0].id === state.roundLosers[1].id) {
        const loser = state.players.get(state.roundLosers[0].id) || state.roundLosers[0];
        io.emit('game:announcement', { type: 'round2Loser', names: [loser.name] });
        setTimeout(() => {
          state.phase = 'finished';
          io.emit('game:finished', { loserId: loser.id, loserName: loser.name, players: getFinishedPlayers(), roundLoserIds: state.roundLosers.map(l => l.id) });
        }, 5000);
      } else {
        io.emit('game:announcement', { type: 'finalStart', names: state.roundLosers.map(l => l.name) });
        setTimeout(() => {
          state.currentRound = 'final';
          state.durchgang = 0;
          state.nextRoundStartId = state.roundLosers[0].id;
          const loserIds = new Set(state.roundLosers.map(l => l.id));
          for (const p of state.players.values()) {
            if (!loserIds.has(p.id)) p.isSpectator = true;
          }
          startLoading();
        }, 5000);
      }
    }, revealShowMs);
    return;
  }

  // Regelverstoß: Rundenverlierer sofort festlegen, restliche Sub-Runden überspringen
  if (ruleViolator) {
    state.roundLosers.push({ id: ruleViolator.id, name: ruleViolator.name });
    state.nextRoundStartId = ruleViolator.id;
    setTimeout(() => {
      for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
      if (state.currentRound === 1) {
        io.emit('game:announcement', { type: 'round1Loser', names: [ruleViolator.name] });
        setTimeout(() => { state.currentRound = 2; state.durchgang = 0; startLoading(); }, 5000);
      } else if (state.roundLosers[0].id === state.roundLosers[1].id) {
        const loser = state.players.get(state.roundLosers[0].id) || state.roundLosers[0];
        io.emit('game:announcement', { type: 'round2Loser', names: [loser.name] });
        setTimeout(() => {
          state.phase = 'finished';
          io.emit('game:finished', { loserId: loser.id, loserName: loser.name, players: getFinishedPlayers(), roundLoserIds: state.roundLosers.map(l => l.id) });
        }, 5000);
      } else {
        io.emit('game:announcement', { type: 'finalStart', names: state.roundLosers.map(l => l.name) });
        setTimeout(() => {
          state.currentRound = 'final';
          state.durchgang = 0;
          state.nextRoundStartId = state.roundLosers[0].id;
          const loserIds = new Set(state.roundLosers.map(l => l.id));
          for (const p of state.players.values()) {
            if (!loserIds.has(p.id)) p.isSpectator = true;
          }
          startLoading();
        }, 5000);
      }
    }, revealShowMs);
    return;
  }

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
          io.emit('game:announcement', { type: 'round1Loser', names: [loser?.name || '?'] });
          setTimeout(() => { state.currentRound = 2; state.durchgang = 0; startLoading(); }, 5000);
        } else if (state.roundLosers[0].id === state.roundLosers[1].id) {
          // Gleicher Spieler hat beide Runden verloren → kein Endspiel
          const l = state.players.get(state.roundLosers[0].id) || state.roundLosers[0];
          io.emit('game:announcement', { type: 'round2Loser', names: [l.name] });
          setTimeout(() => {
            state.phase = 'finished';
            io.emit('game:finished', { loserId: l.id, loserName: l.name, players: getFinishedPlayers(), roundLoserIds: state.roundLosers.map(lo => lo.id) });
          }, 5000);
        } else {
          // Endspiel: nur die zwei Rundenverlierer spielen
          io.emit('game:announcement', { type: 'finalStart', names: state.roundLosers.map(l => l.name) });
          setTimeout(() => {
            state.currentRound = 'final';
            state.durchgang = 0;
            state.nextRoundStartId = state.roundLosers[0].id;
            const loserIds = new Set(state.roundLosers.map(l => l.id));
            for (const p of state.players.values()) {
              if (!loserIds.has(p.id)) p.isSpectator = true;
            }
            startLoading();
          }, 5000);
        }
      }, revealShowMs);
    } else {
      setTimeout(() => {
        state.phase = 'finished';
        io.emit('game:finished', { loserId: loser?.id || null, loserName: loser?.name || '?', players: getFinishedPlayers(), roundLoserIds: state.roundLosers.map(l => l.id) });
      }, revealShowMs);
    }
  } else {
    setTimeout(() => startLoading(), revealShowMs);
  }
}

function getFinishedPlayers() {
  const db = (() => { try { return readDB(); } catch (e) { return []; } })();
  return getPlayers()
    .filter(p => !p.isSpectator || p.guessedCorrect !== undefined)
    .map(p => {
      const entry = findDbEntry(db, p.name);
      return { id: p.id, name: p.name, drink: entry?.lieblingsgetraenk || '' };
    });
}

function resetToLobby() {
  for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
  state.roundStartOffset = 0;
  state.nextRoundStartId = null;
  state.roundMode = false;
  state.currentRound = 1;
  state.roundLosers = [];
  state.durchgang = 0;
  state.phase = 'lobby';
  broadcastLobby();
  io.emit('game:backToLobby');
}

// ─── Socket Events ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('player:join', ({ name }) => {
    if (!name || name.trim() === '') return;
    let resolvedName = name.trim();

    // Frank-Alias
    if (['frank', 'franky', 'frankie', 'fusch'].includes(resolvedName.toLowerCase())) {
      resolvedName = 'Frank Fischer';
    } else {
      // DB-Großschreibung übernehmen
      try {
        const entry = readDB().find(e => e.name.toLowerCase() === resolvedName.toLowerCase());
        if (entry) resolvedName = entry.name;
      } catch (e) {}
    }

    const player = createPlayer(socket.id, resolvedName);
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

  socket.on('host:startGame', () => {
    const player = state.players.get(socket.id);
    if (!player?.isHost) return;
    if (state.players.size < 2) return;
    for (const p of state.players.values()) { p.isSpectator = false; p.guessedCorrect = false; }
    state.roundMode = true;
    state.currentRound = 1;
    state.roundLosers = [];
  state.durchgang = 0;

    const youngestId = getYoungestId();
    if (youngestId) state.nextRoundStartId = youngestId;

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


  socket.on('game:restart', () => {
    if (state.phase === 'finished') resetToLobby();
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
