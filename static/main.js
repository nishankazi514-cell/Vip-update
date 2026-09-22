"use strict";

const socket = io({
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

const $ = (id) => document.getElementById(id);

const views = {
  lobby: $("lobbyView"),
  search: $("searchView"),
  arena: $("arenaView"),
  result: $("resultView"),
  how: $("howView"),
  history: $("historyView"),
};

const state = {
  connected: false,
  searching: false,
  matched: false,
  room: null,
  playerNumber: null,
  round: 1,
  sound: localStorage.getItem("hcd_sound") !== "off",
  countdownTimer: null,
  points: Number(localStorage.getItem("hcd_points") || 1000),
  wins: Number(localStorage.getItem("hcd_wins") || 0),
  losses: Number(localStorage.getItem("hcd_losses") || 0),
  draws: Number(localStorage.getItem("hcd_draws") || 0),
  history: JSON.parse(localStorage.getItem("hcd_history") || "[]"),
};

let audioCtx = null;
let toastTimer = null;

function showView(name) {
  Object.values(views).forEach((view) => view.classList.remove("active"));
  if (views[name]) views[name].classList.add("active");
  window.scrollTo(0, 0);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function saveStats() {
  localStorage.setItem("hcd_points", String(state.points));
  localStorage.setItem("hcd_wins", String(state.wins));
  localStorage.setItem("hcd_losses", String(state.losses));
  localStorage.setItem("hcd_draws", String(state.draws));
  localStorage.setItem("hcd_history", JSON.stringify(state.history));
}

function updateLobby() {
  $("pointsValue").textContent = state.points.toLocaleString();
  $("wins").textContent = state.wins;
  $("losses").textContent = state.losses;
  $("draws").textContent = state.draws;
}

function setConnection(online) {
  state.connected = online;
  const pill = $("connectionPill");
  if (online) {
    pill.className = "status-pill online";
    pill.innerHTML = '<span class="status-dot"></span> ONLINE';
    $("playBtn").disabled = false;
  } else {
    pill.className = "status-pill offline";
    pill.innerHTML = '<span class="status-dot"></span> CONNECTING';
    $("playBtn").disabled = true;
  }
}

function ensureAudio() {
  if (!state.sound) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) {}
}

function tone(freq, duration, type = "sine", volume = 0.055, delay = 0) {
  if (!state.sound) return;
  ensureAudio();
  if (!audioCtx) return;
  const start = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function clickSound() { tone(560, 0.06, "sine", 0.05); }
function matchSound() { tone(660, 0.08, "triangle", 0.07); tone(880, 0.14, "triangle", 0.075, 0.09); }
function countSound() { tone(430, 0.07, "square", 0.045); }
function duelSound() { tone(760, 0.12, "square", 0.06); }
function cardSound() { tone(620, 0.08, "triangle", 0.055); tone(820, 0.11, "triangle", 0.045, 0.07); }
function winSound() { tone(660, 0.08, "triangle", 0.07); tone(820, 0.08, "triangle", 0.07, .09); tone(1040, 0.18, "triangle", 0.08, .18); }
function lossSound() { tone(320, 0.11, "sawtooth", 0.045); tone(220, 0.2, "sawtooth", 0.04, .11); }
function drawSound() { tone(520, 0.1, "sine", 0.05); tone(520, 0.14, "sine", 0.05, .11); }

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function cardMarkup(card) {
  if (!card) return "";
  const red = card.color === "red";
  const cls = red ? "playing-card front-card red reveal" : "playing-card front-card reveal";
  return `
    <div class="${cls}">
      <div class="card-inner">
        <div class="card-corner">${escapeHtml(card.rank)}<span>${escapeHtml(card.suit)}</span></div>
        <div class="card-center">${escapeHtml(card.suit)}</div>
        <div class="card-corner bottom">${escapeHtml(card.rank)}<span>${escapeHtml(card.suit)}</span></div>
      </div>
    </div>`;
}

function resetArena() {
  clearInterval(state.countdownTimer);
  $("arenaStatus").textContent = "Preparing duel...";
  $("countdown").textContent = "3";
  $("countdown").className = "countdown";
  $("oppCard").className = "playing-card back-card";
  $("oppCard").innerHTML = "";
  $("yourCard").className = "playing-card back-card";
  $("yourCard").innerHTML = "";
}

function startSearch() {
  ensureAudio();
  clickSound();

  if (!state.connected) {
    toast("Connecting to game server...");
    return;
  }

  state.searching = true;
  state.matched = false;
  state.room = null;
  state.playerNumber = null;

  $("searchTitle").textContent = "FINDING OPPONENT";
  $("searchStateLabel").textContent = "MATCHMAKING";
  $("searchStatus").textContent = "Searching for another player...";
  $("dots").classList.remove("hidden");
  $("matchFound").classList.add("hidden");
  $("cancelBtn").style.display = "block";
  $("searchOrb").textContent = "🃏";

  showView("search");
  socket.emit("find_match");
}

function leaveAndLobby(showStart = false) {
  socket.emit("leave_match");
  state.searching = false;
  state.matched = false;
  state.room = null;
  state.playerNumber = null;
  showView(showStart ? "lobby" : "lobby");
}

function runCountdown(start) {
  clearInterval(state.countdownTimer);
  let value = Math.max(1, Number(start) || 3);
  $("countdown").textContent = value;
  $("countdown").className = "countdown";
  countSound();

  state.countdownTimer = setInterval(() => {
    value -= 1;
    if (value > 0) {
      $("countdown").textContent = value;
      countSound();
    } else {
      clearInterval(state.countdownTimer);
      $("countdown").textContent = "DUEL!";
      $("countdown").className = "countdown duel";
      $("arenaStatus").textContent = "Cards are being revealed...";
      duelSound();
    }
  }, 1000);
}

function renderResult(data) {
  clearInterval(state.countdownTimer);
  const result = data.result;
  let title = "DRAW";
  let sub = "Both cards have the same rank.";
  let icon = "🤝";
  let delta = 5;

  if (result === "win") {
    title = "YOU WIN";
    sub = "Your card was higher than the opponent's.";
    icon = "🏆";
    delta = 20;
    state.wins += 1;
    state.points += delta;
    winSound();
  } else if (result === "loss") {
    title = "YOU LOSE";
    sub = "The opponent's card was higher.";
    icon = "💫";
    delta = 0;
    state.losses += 1;
    lossSound();
  } else {
    state.draws += 1;
    state.points += delta;
    drawSound();
  }

  $("resultIcon").textContent = icon;
  $("resultTitle").textContent = title;
  $("resultTitle").className = `result-title ${result}`;
  $("resultSub").textContent = sub;
  $("resultOppCard").innerHTML = cardMarkup(data.opponent_card);
  $("resultYourCard").innerHTML = cardMarkup(data.your_card);
  $("pointsDelta").textContent = delta > 0 ? `+${delta} VIRTUAL POINTS` : "NO POINT CHANGE";

  const record = {
    id: Date.now(),
    result,
    your: `${data.your_card.rank}${data.your_card.suit}`,
    opponent: `${data.opponent_card.rank}${data.opponent_card.suit}`,
    time: new Date().toLocaleString(),
    room: state.room || "",
  };
  state.history.unshift(record);
  state.history = state.history.slice(0, 20);
  saveStats();
  updateLobby();

  state.searching = false;
  state.matched = false;

  setTimeout(() => showView("result"), 350);
}

function renderHistory() {
  const list = $("historyList");
  if (!state.history.length) {
    list.innerHTML = `
      <div class="how-card" style="text-align:center;color:#8c96a8;font-size:10px;line-height:1.5;">
        No matches yet.<br>Play your first duel to create history.
      </div>`;
    return;
  }

  list.innerHTML = state.history.map((item) => `
    <div class="history-item">
      <div class="history-icon">${item.result === "win" ? "🏆" : item.result === "loss" ? "💫" : "🤝"}</div>
      <div class="history-main">
        <strong>You ${escapeHtml(item.your)} • Opponent ${escapeHtml(item.opponent)}</strong>
        <small>${escapeHtml(item.time)}</small>
      </div>
      <div class="history-result ${escapeHtml(item.result)}">${escapeHtml(item.result.toUpperCase())}</div>
    </div>`).join("");
}

/* BUTTONS */
$("soundBtn").textContent = state.sound ? "🔊" : "🔇";
$("soundBtn").addEventListener("click", () => {
  state.sound = !state.sound;
  localStorage.setItem("hcd_sound", state.sound ? "on" : "off");
  $("soundBtn").textContent = state.sound ? "🔊" : "🔇";
  if (state.sound) { ensureAudio(); clickSound(); }
});

$("playBtn").addEventListener("click", startSearch);
$("playAgainBtn").addEventListener("click", startSearch);

$("cancelBtn").addEventListener("click", () => {
  clickSound();
  socket.emit("cancel_search");
  socket.emit("leave_match");
  state.searching = false;
  showView("lobby");
});

$("howBtn").addEventListener("click", () => { clickSound(); showView("how"); });
$("howBackBtn").addEventListener("click", () => { clickSound(); showView("lobby"); });
$("historyBtn").addEventListener("click", () => { clickSound(); renderHistory(); showView("history"); });
$("historyBackBtn").addEventListener("click", () => { clickSound(); showView("lobby"); });
$("clearHistoryBtn").addEventListener("click", () => {
  clickSound();
  state.history = [];
  saveStats();
  renderHistory();
  toast("Local history cleared.");
});
$("exitBtn").addEventListener("click", () => {
  clickSound();
  socket.emit("leave_match");
  state.searching = false;
  state.matched = false;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "BDXBET_EXIT_HIGH_CARD_DUEL" }, "*");
  } else if (window.history.length > 1) {
    window.history.back();
  } else {
    showView("lobby");
  }
});
$("arenaBackBtn").addEventListener("click", () => {
  clickSound();
  socket.emit("leave_match");
  state.searching = false;
  state.matched = false;
  showView("lobby");
});
$("resultBackBtn").addEventListener("click", () => { clickSound(); showView("lobby"); });

/* SOCKET */
socket.on("connect", () => {
  setConnection(true);
  if (!state.searching) return;
  socket.emit("find_match");
});

socket.on("connect_error", () => {
  setConnection(false);
  toast("Game server connection failed.");
});

socket.on("disconnect", () => {
  setConnection(false);
  if (state.searching) $("searchStatus").textContent = "Connection lost. Reconnecting...";
});

socket.on("connected", (data) => console.log("High Card Duel connected", data));

socket.on("matchmaking", (data) => {
  state.searching = true;
  $("searchStatus").textContent = data?.message || "Searching for another player...";
});

socket.on("match_found", (data) => {
  state.searching = false;
  state.matched = true;
  state.room = data.room;
  state.playerNumber = Number(data.player_number) || 1;
  const opp = state.playerNumber === 1 ? 2 : 1;

  $("myNumber").textContent = state.playerNumber;
  $("oppNumber").textContent = opp;
  $("searchTitle").textContent = "MATCH FOUND";
  $("searchStateLabel").textContent = "READY";
  $("searchStatus").textContent = "Opponent connected. Starting duel...";
  $("dots").classList.add("hidden");
  $("matchFound").classList.remove("hidden");
  $("cancelBtn").style.display = "none";
  $("searchOrb").textContent = "⚔️";
  matchSound();

  $("youName").textContent = `PLAYER ${state.playerNumber}`;
  $("oppName").textContent = `PLAYER ${opp}`;
  resetArena();

  setTimeout(() => {
    if (state.matched) showView("arena");
  }, 800);
});

socket.on("round_start", (data) => {
  state.round = Number(data?.round) || 1;
  $("arenaStatus").textContent = "Get ready — duel starts soon";
  resetArena();
  showView("arena");
  runCountdown(Number(data?.countdown) || 3);
});

socket.on("reveal_card", (data) => {
  if (!data?.card) return;
  $("yourCard").outerHTML = `<div id="yourCard" class="card-slot">${cardMarkup(data.card)}</div>`;
  cardSound();
  $("arenaStatus").textContent = "Your card is revealed. Waiting for opponent...";
});

socket.on("round_result", (data) => renderResult(data));

socket.on("opponent_left", (data) => {
  clearInterval(state.countdownTimer);
  state.searching = false;
  state.matched = false;
  state.room = null;
  toast(data?.message || "Opponent left the duel.");
  setTimeout(() => showView("lobby"), 650);
});

socket.on("search_cancelled", () => { state.searching = false; });

updateLobby();
setConnection(false);
renderHistory();
