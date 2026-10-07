const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const rooms = new Map();
// Map socketId -> { roomCode, playerId }
const socketMap = new Map();

function clean(s, max = 32) {
  return String(s || "").trim().slice(0, max);
}

function roomCode(name) {
  return clean(name, 24).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function publicRooms() {
  return [...rooms.values()]
    .filter(r => r.visibility === "public" && r.phase === "lobby")
    .map(r => ({ code: r.code, name: r.name, players: r.players.size }));
}

function broadcastPublicRooms() {
  io.emit("public:rooms", publicRooms());
}

/**
 * Generates role-based authoritative state.
 * Active players NEVER receive the secret word or other players' raw guesses.
 * Spectators and MC receive the secret word and all actual guesses.
 */
function roomStateForPlayer(r, p) {
  const isMc = p?.role === "mc";
  const isSpectator = Boolean(p?.spectator);
  const isGameFinished = r.phase === "finished";
  const canSeeSecret = isMc || isSpectator || isGameFinished;
  const canSeeAllGuesses = isMc || isSpectator || isGameFinished;

  const playerGuesses = [...r.guesses.entries()].map(([pid, g]) => {
    const guessingPlayer = r.players.get(pid);
    const isSelf = p && pid === p.id;
    return {
      playerId: pid,
      playerName: guessingPlayer?.name || "Player",
      guess: (canSeeAllGuesses || isSelf) ? g.text : "••••••",
      correct: g.correct,
      hasGuessed: true
    };
  });

  return {
    code: r.code,
    name: r.name,
    visibility: r.visibility,
    phase: r.phase,
    round: r.round,
    minPlayers: 4,
    creatorId: r.creatorId,
    timeLeft: r.timeLeft,
    clue: (r.phase === "playing" || r.phase === "reveal" || isGameFinished) ? r.clue : "",
    secret: canSeeSecret ? r.secret : "",
    players: [...r.players.values()].map(pl => ({
      id: pl.id,
      name: pl.name,
      role: pl.role,
      status: pl.status,
      score: pl.score,
      spectator: pl.spectator,
      connected: pl.connected
    })),
    guesses: playerGuesses,
    spectators: [...r.players.values()].filter(pl => pl.spectator).map(pl => pl.name),
    hasGuessedThisRound: p ? r.guesses.has(p.id) : false,
    viewerRole: p?.role || "guest",
    isSpectator: isSpectator
  };
}

function emitRoom(r) {
  for (const player of r.players.values()) {
    if (player.connected && player.socketId) {
      const sock = io.sockets.sockets.get(player.socketId);
      if (sock) {
        sock.emit("room:update", roomStateForPlayer(r, player));
      }
    }
  }
}

function allNonMcCorrect(r) {
  const nonMc = [...r.players.values()].filter(p => p.role !== "mc" && p.connected);
  return nonMc.length >= 1 && nonMc.every(p => p.spectator);
}

function startNextRoundAutomatically(r) {
  if (!rooms.has(r.code)) return;
  const active = [...r.players.values()].filter(p => p.role !== "mc" && !p.spectator && p.connected);
  if (active.length === 0) {
    r.phase = "finished";
    r.timeLeft = 0;
    emitRoom(r);
    return;
  }

  r.round += 1;
  r.guesses.clear();
  // Automatically begin next round with existing secret, clue, and duration
  beginPlaying(r, r.secret, r.clue, r.roundDuration || 60);
}

function finishRound(r) {
  if (!r || r.phase !== "playing") return;
  clearInterval(r.timer);
  r.timer = null;

  const active = [...r.players.values()].filter(p => p.role !== "mc" && !p.spectator && p.connected);
  if (active.length === 0) {
    r.phase = "finished";
    r.timeLeft = 0;
    emitRoom(r);
    return;
  }

  // Active players remaining: enter reveal gap with 60s automatic countdown for MC to give another clue
  const ROUND_GAP_SECONDS = 60;
  r.phase = "reveal";
  r.timeLeft = ROUND_GAP_SECONDS; // 60 seconds gap so MC can provide another clue
  emitRoom(r);

  // Counter ticks down during 60-second gap
  r.timer = setInterval(() => {
    if (r.phase !== "reveal") {
      clearInterval(r.timer);
      r.timer = null;
      return;
    }
    r.timeLeft--;
    if (r.timeLeft <= 0) {
      clearInterval(r.timer);
      r.timer = null;
      // Start the next round automatically!
      startNextRoundAutomatically(r);
    } else {
      io.to(r.code).emit("timer:tick", { timeLeft: r.timeLeft });
    }
  }, 1000);
}

function beginPlaying(r, secret, clue, seconds) {
  r.phase = "playing";
  r.secret = clean(secret, 80);
  r.clue = clean(clue, 240);
  r.roundDuration = Math.max(15, Math.min(300, Number(seconds) || r.roundDuration || 60));
  r.timeLeft = r.roundDuration;
  r.guesses.clear();
  r.players.forEach(p => {
    if (p.role === "mc") p.status = "mc";
    else if (!p.spectator) p.status = "guessing";
  });

  clearInterval(r.timer);
  r.timer = setInterval(() => {
    if (r.phase !== "playing") return;
    r.timeLeft--;
    if (r.timeLeft <= 0) {
      finishRound(r);
    } else {
      // High-frequency tick sends only the counter, avoiding full DOM re-renders on the client
      io.to(r.code).emit("timer:tick", { timeLeft: r.timeLeft });
    }
  }, 1000);

  emitRoom(r);
}

function handlePermanentDisconnect(code, playerId) {
  const r = rooms.get(code);
  if (!r) return;
  const p = r.players.get(playerId);
  if (!p || p.connected) return; // Player reconnected

  const wasCreator = r.creatorId === playerId;
  const wasMc = p.role === "mc";

  r.players.delete(playerId);

  if (r.players.size === 0) {
    clearInterval(r.timer);
    rooms.delete(code);
    broadcastPublicRooms();
    return;
  }

  if (wasCreator) {
    const nextPlayer = [...r.players.values()].find(pl => pl.connected) || r.players.values().next().value;
    if (nextPlayer) {
      r.creatorId = nextPlayer.id;
      if (nextPlayer.role === "player") nextPlayer.role = "creator";
    }
  }

  if (wasMc && r.phase !== "lobby" && r.phase !== "finished") {
    r.phase = "lobby";
    r.round = 0;
    r.secret = "";
    r.clue = "";
    r.guesses.clear();
    r.players.forEach(pl => {
      pl.role = pl.id === r.creatorId ? "creator" : "player";
      pl.status = "lobby";
      pl.spectator = false;
    });
    clearInterval(r.timer);
    r.timer = null;
    io.to(code).emit("error:msg", "The MC disconnected. Game has returned to the lobby.");
  } else if (r.phase === "playing") {
    // Check if remaining active players all solved
    if (allNonMcCorrect(r)) {
      finishRound(r);
    }
  }

  emitRoom(r);
  broadcastPublicRooms();
}

io.on("connection", socket => {
  socket.emit("public:rooms", publicRooms());

  socket.on("rooms:list", () => socket.emit("public:rooms", publicRooms()));

  // CREATE ROOM
  socket.on("room:create", async ({ name, password, visibility, playerName }) => {
    try {
      const code = roomCode(name) || "KIRA-" + crypto.randomBytes(2).toString("hex").toUpperCase();
      if (rooms.has(code)) {
        return socket.emit("error:msg", "That room name is already in use.");
      }

      const isPrivate = visibility !== "public";
      const cleanPassword = clean(password, 64);
      if (isPrivate && !cleanPassword) {
        return socket.emit("error:msg", "Private rooms require a password.");
      }

      const cleanName = clean(playerName, 24) || "Host";
      const playerId = crypto.randomBytes(8).toString("hex");
      const sessionToken = crypto.randomBytes(16).toString("hex");

      const room = {
        code,
        name: clean(name, 32) || code,
        visibility: isPrivate ? "private" : "public",
        passwordHash: isPrivate ? await bcrypt.hash(cleanPassword, 10) : null,
        creatorId: playerId,
        phase: "lobby",
        round: 0,
        players: new Map(),
        secret: "",
        clue: "",
        guesses: new Map(),
        timeLeft: 0,
        timer: null
      };

      const hostPlayer = {
        id: playerId,
        token: sessionToken,
        name: cleanName,
        socketId: socket.id,
        connected: true,
        role: "creator",
        status: "lobby",
        score: 0,
        spectator: false,
        disconnectTimer: null
      };

      room.players.set(playerId, hostPlayer);
      rooms.set(code, room);

      socket.join(code);
      socketMap.set(socket.id, { roomCode: code, playerId });

      socket.emit("room:joined", {
        session: { code, playerId, token: sessionToken, playerName: cleanName },
        state: roomStateForPlayer(room, hostPlayer)
      });
      broadcastPublicRooms();
    } catch (err) {
      console.error("Create room error:", err);
      socket.emit("error:msg", "Could not create the room.");
    }
  });

  // JOIN ROOM
  socket.on("room:join", async ({ code, password, playerName }) => {
    try {
      const r = rooms.get(roomCode(code));
      if (!r) return socket.emit("error:msg", "Room not found.");
      if (r.phase !== "lobby") return socket.emit("error:msg", "That game has already started.");
      if (r.players.size >= 30) return socket.emit("error:msg", "Room is at maximum capacity (30 players).");

      if (r.visibility === "private") {
        if (!r.passwordHash || !(await bcrypt.compare(String(password || ""), r.passwordHash))) {
          return socket.emit("error:msg", "Wrong room password.");
        }
      }

      const cleanName = clean(playerName, 24) || "Player";
      if ([...r.players.values()].some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
        return socket.emit("error:msg", "That player name is already taken.");
      }

      const playerId = crypto.randomBytes(8).toString("hex");
      const sessionToken = crypto.randomBytes(16).toString("hex");

      const newPlayer = {
        id: playerId,
        token: sessionToken,
        name: cleanName,
        socketId: socket.id,
        connected: true,
        role: "player",
        status: "lobby",
        score: 0,
        spectator: false,
        disconnectTimer: null
      };

      r.players.set(playerId, newPlayer);
      socket.join(r.code);
      socketMap.set(socket.id, { roomCode: r.code, playerId });

      socket.emit("room:joined", {
        session: { code: r.code, playerId, token: sessionToken, playerName: cleanName },
        state: roomStateForPlayer(r, newPlayer)
      });
      emitRoom(r);
      broadcastPublicRooms();
    } catch (err) {
      console.error("Join room error:", err);
      socket.emit("error:msg", "Could not join the room.");
    }
  });

  // RECONNECT TO EXISTING SESSION
  socket.on("room:reconnect", ({ code, playerId, token }) => {
    const r = rooms.get(roomCode(code));
    if (!r) return socket.emit("reconnect:failed", { msg: "Room no longer exists." });

    const p = r.players.get(playerId);
    if (!p || p.token !== token) {
      return socket.emit("reconnect:failed", { msg: "Session expired or invalid." });
    }

    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }

    // Unmap old socket if any
    if (p.socketId && socketMap.has(p.socketId)) {
      socketMap.delete(p.socketId);
    }

    p.socketId = socket.id;
    p.connected = true;
    socket.join(r.code);
    socketMap.set(socket.id, { roomCode: r.code, playerId });

    socket.emit("room:joined", {
      session: { code: r.code, playerId: p.id, token: p.token, playerName: p.name },
      state: roomStateForPlayer(r, p)
    });
    emitRoom(r);
  });

  // START GAME (Creator only)
  socket.on("game:start", () => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    const r = rooms.get(mapping.roomCode);
    if (!r || r.creatorId !== mapping.playerId) return;
    if (r.players.size < 4) {
      return socket.emit("error:msg", "At least 4 players are required to start.");
    }

    const playerList = [...r.players.values()];
    const chosenIndex = Math.floor(Math.random() * playerList.length);
    const chosenMc = playerList[chosenIndex];

    playerList.forEach(p => {
      p.score = 0;
      p.spectator = false;
      p.status = "waiting";
      if (p.id === chosenMc.id) {
        p.role = "mc";
      } else if (p.id === r.creatorId) {
        p.role = "creator";
      } else {
        p.role = "player";
      }
    });

    r.phase = "waiting";
    r.round = 1;
    r.secret = "";
    r.clue = "";
    r.guesses.clear();
    emitRoom(r);
    broadcastPublicRooms();
  });

  // MC STARTS ROUND
  socket.on("mc:startRound", ({ secret, clue, seconds }) => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    const r = rooms.get(mapping.roomCode);
    const p = r?.players.get(mapping.playerId);
    if (!r || !p || p.role !== "mc") return;
    if (r.phase !== "waiting") return;

    const cleanSecret = clean(secret, 80);
    const cleanClue = clean(clue, 240);
    if (!cleanSecret || !cleanClue) {
      return socket.emit("error:msg", "Enter both a secret word and a clue.");
    }

    beginPlaying(r, cleanSecret, cleanClue, seconds);
  });

  // MC UPDATES CLUE IN REAL TIME
  socket.on("mc:updateClue", ({ clue }) => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    const r = rooms.get(mapping.roomCode);
    const p = r?.players.get(mapping.playerId);
    if (!r || !p || p.role !== "mc") return;
    const cleanClue = clean(clue, 240);
    if (!cleanClue) return;
    r.clue = cleanClue;
    emitRoom(r);
  });

  // MC CAN SKIP GAP WAIT AND START IMMEDIATELY (WITH OPTIONAL NEW CLUE)
  socket.on("mc:nextRoundNow", ({ clue } = {}) => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    const r = rooms.get(mapping.roomCode);
    const p = r?.players.get(mapping.playerId);
    if (!r || !p || p.role !== "mc" || r.phase !== "reveal") return;
    if (clue) {
      const cleanClue = clean(clue, 240);
      if (cleanClue) r.clue = cleanClue;
    }
    clearInterval(r.timer);
    r.timer = null;
    startNextRoundAutomatically(r);
  });

  // SUBMIT GUESS
  socket.on("guess:submit", ({ guess }) => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    const r = rooms.get(mapping.roomCode);
    const p = r?.players.get(mapping.playerId);
    if (!r || !p || r.phase !== "playing" || p.role === "mc" || p.spectator) return;
    if (r.guesses.has(p.id)) {
      return socket.emit("error:msg", "Your guess is already locked for this round.");
    }

    const g = clean(guess, 80);
    if (!g) return;

    const isCorrect = g.toLowerCase() === r.secret.toLowerCase();
    r.guesses.set(p.id, { text: g, correct: isCorrect });

    if (isCorrect) {
      p.spectator = true;
      p.status = "spectator";
      p.score += 1;
      socket.emit("guess:result", { correct: true, msg: "Correct! You are now a spectator." });
      if (allNonMcCorrect(r)) {
        return finishRound(r);
      }
    } else {
      p.status = "waiting";
      socket.emit("guess:result", { correct: false, msg: "Wrong guess! Wait for the round to end." });
    }

    // Check if every active player has locked their guess
    const activeGuessers = [...r.players.values()].filter(pl => pl.role !== "mc" && !pl.spectator);
    if (activeGuessers.length > 0 && activeGuessers.every(pl => r.guesses.has(pl.id))) {
      // All active players locked their guesses; finish round early
      finishRound(r);
      return;
    }

    emitRoom(r);
  });

  // RESET / REPLAY GAME (Creator only)
  socket.on("game:reset", () => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    const r = rooms.get(mapping.roomCode);
    if (!r || r.creatorId !== mapping.playerId) return;

    clearInterval(r.timer);
    r.timer = null;
    r.phase = "lobby";
    r.round = 0;
    r.secret = "";
    r.clue = "";
    r.guesses.clear();
    r.players.forEach(p => {
      p.role = p.id === r.creatorId ? "creator" : "player";
      p.status = "lobby";
      p.spectator = false;
      p.score = 0;
    });

    emitRoom(r);
    broadcastPublicRooms();
  });

  // LEAVE ROOM
  socket.on("room:leave", () => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    socketMap.delete(socket.id);
    handlePermanentDisconnect(mapping.roomCode, mapping.playerId);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const mapping = socketMap.get(socket.id);
    if (!mapping) return;
    socketMap.delete(socket.id);

    const r = rooms.get(mapping.roomCode);
    if (!r) return;
    const p = r.players.get(mapping.playerId);
    if (!p) return;

    p.connected = false;
    p.socketId = null;

    // Broadcast disconnected status
    emitRoom(r);

    // 45-second reconnect grace window
    p.disconnectTimer = setTimeout(() => {
      handlePermanentDisconnect(mapping.roomCode, mapping.playerId);
    }, 45000);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`KIRA Game's hub running on port ${PORT}`);
});