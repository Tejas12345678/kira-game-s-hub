const socket = io();
let me = null;
let state = null;
let mySession = null;
let currentRound = 0;

const $ = id => document.getElementById(id);

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "toast error-toast" : "toast";
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

socket.on("error:msg", msg => toast(msg, true));

socket.on("connect", () => {
  $("connBadge") && ($("connBadge").textContent = "CONNECTED", $("connBadge").className = "pill pill-green");
  // Try reconnecting to an ongoing session if found
  const saved = sessionStorage.getItem("kira_session");
  if (saved) {
    try {
      const sess = JSON.parse(saved);
      if (sess && sess.code && sess.playerId && sess.token) {
        socket.emit("room:reconnect", sess);
      }
    } catch {
      sessionStorage.removeItem("kira_session");
    }
  } else {
    socket.emit("rooms:list");
  }
});

socket.on("disconnect", () => {
  $("connBadge") && ($("connBadge").textContent = "DISCONNECTED", $("connBadge").className = "pill pill-red");
  toast("Connection lost. Trying to reconnect...", true);
});

socket.on("reconnect:failed", ({ msg }) => {
  sessionStorage.removeItem("kira_session");
  mySession = null;
  me = null;
  state = null;
  showHome();
  toast(msg || "Could not reconnect to previous room.", true);
  socket.emit("rooms:list");
});

socket.on("room:joined", ({ session, state: s }) => {
  mySession = session;
  sessionStorage.setItem("kira_session", JSON.stringify(session));
  state = s;
  me = s.players.find(p => p.id === session.playerId) || null;
  currentRound = s.round;
  showRoom();
});

socket.on("room:update", s => {
  const previousRound = currentRound;
  state = s;
  currentRound = s.round;
  if (mySession) {
    me = s.players.find(p => p.id === mySession.playerId) || me;
  }

  // Clear typed guess only when round increments
  if (previousRound !== currentRound) {
    const input = $("guessInput");
    if (input) input.value = "";
  }

  showRoom();
});

// High-frequency lightweight timer tick (Does NOT rebuild any DOM elements!)
socket.on("timer:tick", ({ timeLeft }) => {
  if (state) state.timeLeft = timeLeft;
  renderTimer(timeLeft);
});

socket.on("guess:result", ({ correct, msg }) => {
  toast(msg || (correct ? "Correct! You are now a spectator." : "Wrong guess!"), !correct);
});

socket.on("public:rooms", rooms => {
  const box = $("publicRooms");
  if (!rooms || !rooms.length) {
    box.innerHTML = '<div class="muted">No public rooms open right now.</div>';
    return;
  }
  box.innerHTML = rooms.map(r => `
    <div class="player">
      <div>
        <b>${esc(r.name)}</b>
        <div class="muted">${r.players} player(s)</div>
      </div>
      <button class="btn-sm" onclick="quickJoin('${esc(r.code)}')">Join</button>
    </div>
  `).join("");
});

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function formatTimer(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function renderTimer(timeLeft) {
  const el = $("timer");
  if (el) el.textContent = formatTimer(timeLeft);
}

function togglePasswordVisibility() {
  const isPrivate = $("visibility").value === "private";
  $("roomPass").style.display = isPrivate ? "block" : "none";
}

function refreshPublicRooms() {
  socket.emit("rooms:list");
}

function createRoom() {
  const playerName = $("createName").value.trim();
  const roomName = $("roomName").value.trim();
  const visibility = $("visibility").value;
  const password = $("roomPass").value;

  if (!playerName) return toast("Please enter your player name.", true);
  if (!roomName) return toast("Please enter a room name.", true);
  if (visibility === "private" && !password) return toast("Password is required for private rooms.", true);

  socket.emit("room:create", { name: roomName, password, visibility, playerName });
}

function joinRoom() {
  const playerName = $("joinName").value.trim();
  const code = $("joinCode").value.trim();
  const password = $("joinPass").value;

  if (!playerName) return toast("Please enter your player name.", true);
  if (!code) return toast("Please enter the room name or code.", true);

  socket.emit("room:join", { code, password, playerName });
}

function quickJoin(code) {
  const playerName = prompt("Enter your player name:");
  if (playerName && playerName.trim()) {
    socket.emit("room:join", { code, password: "", playerName: playerName.trim() });
  }
}

function leaveRoom() {
  sessionStorage.removeItem("kira_session");
  mySession = null;
  me = null;
  state = null;
  socket.emit("room:leave");
  showHome();
  socket.emit("rooms:list");
}

function startGame() {
  socket.emit("game:start");
}

function startRound() {
  const secret = $("secret").value.trim();
  const clue = $("clue").value.trim();
  const seconds = $("seconds").value;

  if (!secret) return toast("Please enter a secret word.", true);
  if (!clue) return toast("Please enter a clue.", true);

  socket.emit("mc:startRound", { secret, clue, seconds });
}

function submitGuess(e) {
  if (e) e.preventDefault();
  const input = $("guessInput");
  const guess = input.value.trim();
  if (!guess) return;

  socket.emit("guess:submit", { guess });
}

function resetGame() {
  socket.emit("game:reset");
}

function updateClue() {
  const input = $("updateClueInput");
  const clue = input.value.trim();
  if (!clue) return toast("Enter a clue or hint first.", true);
  socket.emit("mc:updateClue", { clue });
  input.value = "";
  toast("Clue updated!");
}

function skipReveal() {
  socket.emit("mc:nextRoundNow");
}

function submitGapClue() {
  const input = $("gapClueInput");
  const clue = input ? input.value.trim() : "";
  if (!clue) return toast("Enter another clue first.", true);
  socket.emit("mc:updateClue", { clue });
  toast("New clue submitted!");
}

function submitGapClueAndStart() {
  const input = $("gapClueInput");
  const clue = input ? input.value.trim() : "";
  socket.emit("mc:nextRoundNow", { clue });
}

function showHome() {
  $("home").classList.remove("hidden");
  $("room").classList.add("hidden");
}

function showRoom() {
  if (!state || !me) return;
  $("home").classList.add("hidden");
  $("room").classList.remove("hidden");

  // Header and Pills
  $("roomTitle").textContent = `${state.name} (${state.code})`;

  const roleText = me.role === "mc" ? "MC" : me.spectator ? "SPECTATOR" : me.role === "creator" ? "ROOM HOST" : "GUESSER";
  $("roleBadge").textContent = roleText;
  $("roleBadge").className = `pill pill-${me.role === "mc" ? "gold" : me.spectator ? "purple" : "blue"}`;

  $("phaseBadge").textContent = state.phase.toUpperCase();

  // Hints
  const hintEl = $("roomHint");
  if (state.phase === "lobby") {
    hintEl.textContent = state.players.length < 4
      ? `Waiting for at least 4 players (${state.players.length}/4 joined). The room creator can then start.`
      : "4 or more players joined! The room creator can start the game now.";
  } else if (state.phase === "waiting") {
    hintEl.textContent = me.role === "mc"
      ? "You are the MC! Enter a secret word and a clue to start the round."
      : "Waiting for the MC to submit the secret word and start the round...";
  } else if (state.phase === "playing") {
    hintEl.textContent = me.role === "mc"
      ? "Round in progress! Watch the players make their guesses."
      : me.spectator
      ? "You solved the word! You are now spectating remaining players."
      : "Read the clue and enter your guess. Players who solve it become spectators!";
  } else if (state.phase === "reveal") {
    hintEl.textContent = "Round complete! Preparing for the next round...";
  } else if (state.phase === "finished") {
    hintEl.textContent = "Game Over! All non-MC players successfully guessed the word!";
  }

  // Players list
  $("players").innerHTML = state.players.map(p => `
    <div class="player ${p.spectator ? 'correct' : ''} ${!p.connected ? 'offline' : ''}">
      <div class="player-top">
        <b>${esc(p.name)}</b>
        ${!p.connected ? '<span class="status-badge badge-offline">Offline</span>' : ''}
      </div>
      <div class="muted role-label">${p.role === 'mc' ? '★ MC' : p.spectator ? '👁 SPECTATOR' : p.role === 'creator' ? 'HOST' : 'PLAYER'}</div>
      <div class="player-foot">
        <span class="muted">${p.spectator ? 'Solved' : p.status}</span>
        <span class="score-badge">Pts: ${p.score}</span>
      </div>
    </div>
  `).join("");

  // Host controls (Lobby only)
  const isCreator = me.id === state.creatorId;
  $("creatorControls").classList.toggle("hidden", !(isCreator && state.phase === "lobby"));
  if (isCreator && state.phase === "lobby") {
    const startBtn = $("startBtn");
    startBtn.disabled = state.players.length < 4;
    startBtn.textContent = state.players.length < 4
      ? `Need ${4 - state.players.length} more player(s) to start`
      : "Start Game (Random MC Selection)";
  }

  // MC Controls (Waiting phase only)
  const isMcWaiting = me.role === "mc" && state.phase === "waiting";
  $("mcControls").classList.toggle("hidden", !isMcWaiting);

  // Playing / Reveal Area
  const showGameArea = state.phase === "playing" || state.phase === "reveal";
  $("gameArea").classList.toggle("hidden", !showGameArea);

  if (showGameArea) {
    renderTimer(state.timeLeft);
    const timerLabel = $("timerLabel");
    if (timerLabel) {
      timerLabel.textContent = state.phase === "reveal" ? "NEXT ROUND STARTS IN" : "TIME REMAINING";
    }
    $("clueText").textContent = state.clue || "No clue provided.";

    // Secret Word banner (Authoritative: only shown if server provided secret)
    const secretBanner = $("secretBanner");
    if (state.secret) {
      secretBanner.classList.remove("hidden");
      $("secretWordDisplay").textContent = state.secret;
    } else {
      secretBanner.classList.add("hidden");
    }

    // MC Live Hint Panel
    const isMc = me.role === "mc";
    const mcLivePanel = $("mcLivePanel");
    if (mcLivePanel) {
      mcLivePanel.classList.toggle("hidden", !isMc);
      $("skipRevealBtn")?.classList.toggle("hidden", !(isMc && state.phase === "reveal"));
    }

    // PERSISTENT GUESS INPUT - We DO NOT destroy or replace input DOM nodes!
    const guessForm = $("guessForm");
    const guessStatus = $("guessStatus");
    const guessInput = $("guessInput");
    const guessBtn = $("guessBtn");

    const isSpectator = me.spectator;
    const hasLocked = state.hasGuessedThisRound;

    if (state.phase === "playing") {
      if (isMc) {
        guessForm.classList.add("hidden");
        guessStatus.classList.remove("hidden");
        guessStatus.textContent = "You are the MC. Watch players' guesses live below.";
      } else if (isSpectator) {
        guessForm.classList.add("hidden");
        guessStatus.classList.remove("hidden");
        guessStatus.textContent = "You solved the word! You are spectating the remaining players.";
      } else if (hasLocked) {
        guessForm.classList.add("hidden");
        guessStatus.classList.remove("hidden");
        guessStatus.textContent = "Your guess is locked! Waiting for round countdown to complete.";
      } else {
        // Active guessing player
        guessForm.classList.remove("hidden");
        guessStatus.classList.add("hidden");
        guessInput.disabled = false;
        guessBtn.disabled = false;
        if (document.activeElement !== guessInput) {
          guessInput.focus();
        }
      }
    } else {
      // Reveal phase
      guessForm.classList.add("hidden");
      guessStatus.classList.remove("hidden");
      guessStatus.textContent = "Round complete. Starting next round countdown automatically...";
    }

    // Live guess activity feed
    const feed = $("guessFeed");
    if (!state.guesses || !state.guesses.length) {
      feed.innerHTML = '<div class="muted">No guesses submitted yet this round.</div>';
    } else {
      feed.innerHTML = state.guesses.map(g => `
        <div class="feed ${g.correct ? 'feed-correct' : ''}">
          <b>${esc(g.playerName)}</b>: 
          <span>${esc(g.guess)}</span>
          ${g.correct ? '<span class="pill pill-green pill-xs">SOLVED</span>' : ''}
        </div>
      `).join("");
    }
  }

  // Reveal / 60s Intermission Area
  const revealArea = $("revealArea");
  if (state.phase === "reveal") {
    revealArea.classList.remove("hidden");
    const isMc = me.role === "mc";
    const mcGapBox = $("mcGapBox");
    if (mcGapBox) {
      mcGapBox.classList.toggle("hidden", !isMc);
    }

    $("revealText").innerHTML = `
      <p style="font-size:16px;">Round ${state.round} has ended!</p>
      <div style="background:#090f1f;padding:10px 14px;border-radius:8px;border:1px solid #293353;margin:10px 0;">
        <span class="muted" style="font-size:11px;font-weight:700;">CURRENT CLUE:</span>
        <div style="font-weight:600;color:#f5f7ff;margin-top:2px;">${esc(state.clue)}</div>
      </div>
      ${state.secret ? `<p>Secret word: <b style="color:#18d6a4;font-size:18px;">${esc(state.secret)}</b></p>` : `<p class="muted">The secret word remains hidden from active players.</p>`}
      <p style="color:#18d6a4;font-weight:700;margin-top:8px;">
        ⏱️ 60-second gap in progress — MC can provide another clue. Next round counter starts automatically!
      </p>
    `;
  } else {
    revealArea.classList.add("hidden");
    const mcGapBox = $("mcGapBox");
    if (mcGapBox) mcGapBox.classList.add("hidden");
  }

  // Finished Area (Game Over)
  const finArea = $("finishedArea");
  if (state.phase === "finished") {
    finArea.classList.remove("hidden");
    $("finalScoreboard").innerHTML = state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p, idx) => `
        <div class="player ${p.spectator ? 'correct' : ''}">
          <b>#${idx + 1} ${esc(p.name)}</b>
          <div class="muted">${p.role === 'mc' ? 'MC' : p.spectator ? 'SOLVED' : 'PARTICIPANT'}</div>
          <div><b>Score: ${p.score}</b></div>
        </div>
      `).join("");
    $("finishedCreatorActions").classList.toggle("hidden", !isCreator);
  } else {
    finArea.classList.add("hidden");
  }
}
