/* ==========================================================================
   Speed Tap Arena - client
   ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    banner: $('conn-banner'),
    toast: $('toast'),
    sr: $('sr-status'),

    home: $('screen-home'),
    queue: $('screen-queue'),
    arena: $('screen-arena'),

    nameInput: $('name-input'),
    btnFind: $('btn-find'),
    stats: $('stats'),
    btnCancel: $('btn-cancel'),
    btnQuit: $('btn-quit'),

    youName: $('you-name'),
    oppName: $('opp-name'),
    youPips: $('you-pips'),
    oppPips: $('opp-pips'),
    roundLabel: $('round-label'),

    kicker: $('stage-kicker'),
    main: $('stage-main'),
    sub: $('stage-sub'),

    card: $('round-card'),
    rcTitle: $('rc-title'),
    rcYou: $('rc-you'),
    rcOpp: $('rc-opp'),
    rcNote: $('rc-note'),

    final: $('final'),
    finalTitle: $('final-title'),
    finalScore: $('final-score'),
    finalReason: $('final-reason'),
    recapBody: $('recap-body'),
    btnAgain: $('btn-again'),
    btnHome: $('btn-home'),
  };

  const screens = { home: el.home, queue: el.queue, arena: el.arena };
  const NAME_KEY = 'speedTapArena:name';

  const state = {
    screen: 'home',
    phase: 'idle',
    inMatch: false,
    signalAt: null,
    roundsToWin: 2,
    wasDisconnected: false,
    toastTimer: null,
  };

  // ------------------------------------------------------------------
  // Socket connection — polling first for maximum ISP/firewall compat
  // ------------------------------------------------------------------
  if (typeof io === 'undefined') {
    alert('Socket.IO client failed to load. Please check your internet connection and reload.');
    return;
  }

  const socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionAttempts: Infinity,
  });

  // Debug: open with ?debug=1 to log every socket event in the console
  if (new URLSearchParams(location.search).has('debug')) {
    socket.onAny((ev, ...args) => console.log('[socket]', ev, ...args));
    socket.on('connect', () => console.log('[socket] connected', socket.id));
    socket.on('connect_error', (e) => console.error('[socket] error', e.message));
    socket.on('disconnect', (r) => console.warn('[socket] disconnect', r));
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const fmtMs = (ms) => (ms == null ? '—' : `${Math.round(ms)} ms`);

  function loadName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  }
  function saveName(v) {
    try { localStorage.setItem(NAME_KEY, v); } catch { /* ignore */ }
  }
  function cleanName(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  }

  function announce(text) {
    el.sr.textContent = '';
    setTimeout(() => { el.sr.textContent = text; }, 30);
  }

  function toast(message, ms = 4200) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function showScreen(name) {
    state.screen = name;
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('is-active', key === name);
    });
    if (name === 'home') el.btnFind.disabled = !socket.connected;
    if (name === 'arena' && document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  }

  function setPhase(phase) {
    state.phase = phase;
    el.arena.dataset.phase = phase;
  }

  function setStage({ kicker = '', main = '', sub = '' } = {}) {
    el.kicker.textContent = kicker;
    el.main.textContent = main;
    el.sub.textContent = sub;
  }

  function popMain() {
    el.main.classList.remove('pop');
    void el.main.offsetWidth;
    el.main.classList.add('pop');
  }

  function renderPips(container, filled) {
    container.textContent = '';
    for (let i = 0; i < state.roundsToWin; i += 1) {
      const pip = document.createElement('span');
      pip.className = 'pip' + (i < filled ? ' is-on' : '');
      container.appendChild(pip);
    }
  }

  function setScores(you, opp) {
    renderPips(el.youPips, you);
    renderPips(el.oppPips, opp);
  }

  function hideRoundCard() { el.card.hidden = true; }
  function hideFinal() { el.final.hidden = true; }

  /* ------------------------------------------------------------------ */
  /* Home / queue                                                        */
  /* ------------------------------------------------------------------ */
  el.nameInput.value = loadName();

  function findMatch() {
    if (!socket.connected) {
      toast('Not connected to the server yet. Please wait a moment.');
      return;
    }
    const name = cleanName(el.nameInput.value);
    el.nameInput.value = name;
    saveName(name);
    el.btnFind.disabled = true;
    socket.emit('find_match', { name });
  }

  el.btnFind.addEventListener('click', findMatch);
  el.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') findMatch();
  });

  el.btnCancel.addEventListener('click', () => {
    socket.emit('cancel_search');
  });

  el.btnQuit.addEventListener('click', () => {
    if (!window.confirm('Quit this match? You will forfeit it.')) return;
    socket.emit('leave_match');
    state.inMatch = false;
    hideRoundCard();
    hideFinal();
    showScreen('home');
  });

  el.btnAgain.addEventListener('click', () => {
    hideFinal();
    showScreen('queue');
    socket.emit('find_match', { name: cleanName(el.nameInput.value) });
  });

  el.btnHome.addEventListener('click', () => {
    hideFinal();
    showScreen('home');
  });

  /* ------------------------------------------------------------------ */
  /* Tapping                                                             */
  /* ------------------------------------------------------------------ */
  function eventTime(e) {
    const now = performance.now();
    const t = e && typeof e.timeStamp === 'number' ? e.timeStamp : now;
    return t > 0 && Math.abs(now - t) < 1000 ? t : now;
  }

  function doTap(t) {
    if (state.screen !== 'arena' || !state.inMatch) return;

    if (state.phase === 'wait') {
      setPhase('foul');
      setStage({ kicker: 'False start', main: 'Too early!', sub: '' });
      socket.emit('tap', { early: true });
      return;
    }

    if (state.phase === 'go' && state.signalAt !== null) {
      const ms = Math.max(0, Math.round((t - state.signalAt) * 10) / 10);
      setPhase('locked');
      setStage({ kicker: 'Locked in', main: fmtMs(ms), sub: 'Waiting for your opponent…' });
      socket.emit('tap', { reaction_ms: ms });
    }
  }

  el.arena.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target.closest('[data-no-tap]')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      doTap(eventTime(e));
    },
    { passive: false }
  );

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if (state.screen !== 'arena' || !el.final.hidden) return;
    if (state.phase !== 'wait' && state.phase !== 'go') return;
    e.preventDefault();
    doTap(eventTime(e));
  });

  /* ------------------------------------------------------------------ */
  /* Round result text                                                   */
  /* ------------------------------------------------------------------ */
  function describeRound(r) {
    const diff =
      r.your_time != null && r.opp_time != null
        ? Math.round(Math.abs(r.your_time - r.opp_time))
        : null;

    if (r.outcome === 'draw') {
      return {
        title: 'Draw',
        note:
          r.reason === 'tie'
            ? 'Exactly the same time. This round will be replayed.'
            : 'Nobody tapped in time. This round will be replayed.',
      };
    }

    if (r.reason === 'false_start') {
      return r.outcome === 'win'
        ? { title: 'Round won', note: 'Your opponent tapped before the signal.' }
        : { title: 'Round lost', note: 'You tapped before the signal.' };
    }

    if (r.reason === 'timeout') {
      return r.outcome === 'win'
        ? { title: 'Round won', note: 'Your opponent did not tap in time.' }
        : { title: 'Round lost', note: 'You did not tap in time.' };
    }

    return r.outcome === 'win'
      ? { title: 'Round won', note: `You were ${diff} ms faster.` }
      : { title: 'Round lost', note: `Your opponent was ${diff} ms faster.` };
  }

  function showRoundResult(r) {
    const d = describeRound(r);
    el.card.dataset.outcome = r.outcome;
    el.rcTitle.textContent = d.title;
    el.rcYou.textContent = r.foul === 'you' ? 'False start' : fmtMs(r.your_time);
    el.rcOpp.textContent = r.foul === 'opponent' ? 'False start' : fmtMs(r.opp_time);
    el.rcNote.textContent = r.match_over ? `${d.note} Final result coming up…` : d.note;
    el.card.hidden = false;
    announce(`${d.title}. ${d.note}`);
  }

  /* ------------------------------------------------------------------ */
  /* Final popup                                                         */
  /* ------------------------------------------------------------------ */
  function cellText(r, who) {
    if (who === 'you') {
      if (r.foul === 'you') return 'False start';
      return r.your_time != null ? fmtMs(r.your_time) : 'No tap';
    }
    if (r.foul === 'opponent') return 'False start';
    return r.opp_time != null ? fmtMs(r.opp_time) : 'No tap';
  }

  function buildRecap(rounds) {
    el.recapBody.textContent = '';
    rounds.forEach((r) => {
      const tr = document.createElement('tr');

      const c1 = document.createElement('td');
      c1.textContent = String(r.round);

      const c2 = document.createElement('td');
      c2.textContent = cellText(r, 'you');

      const c3 = document.createElement('td');
      c3.textContent = cellText(r, 'opp');

      const c4 = document.createElement('td');
      const chip = document.createElement('span');
      chip.className = `res res--${r.outcome}`;
      chip.textContent = r.outcome === 'win' ? 'Won' : r.outcome === 'lose' ? 'Lost' : 'Draw';
      c4.appendChild(chip);

      tr.append(c1, c2, c3, c4);
      el.recapBody.appendChild(tr);
    });
  }

  function showFinal(m) {
    const won = m.result === 'victory';
    el.final.dataset.outcome = m.result;
    el.finalTitle.textContent = won ? 'Victory' : 'Defeat';
    el.finalScore.textContent = `${m.scores.you} – ${m.scores.opponent}`;

    if (m.reason === 'opponent_left') {
      el.finalReason.textContent = 'Your opponent left the match.';
    } else {
      el.finalReason.textContent = won
        ? 'You took the match. Nice reflexes.'
        : 'Your opponent took the match.';
    }

    buildRecap(m.rounds || []);
    hideRoundCard();
    el.final.hidden = false;
    el.btnAgain.focus();
    announce(won ? 'Victory' : 'Defeat');
  }

  /* ------------------------------------------------------------------ */
  /* Socket events                                                       */
  /* ------------------------------------------------------------------ */
  socket.on('connect', () => {
    el.banner.hidden = true;
    el.btnFind.disabled = state.screen !== 'home';

    if (state.wasDisconnected) {
      state.wasDisconnected = false;
      if (state.inMatch || state.screen !== 'home') {
        state.inMatch = false;
        hideRoundCard();
        hideFinal();
        showScreen('home');
        toast('Connection was lost, so your match ended. Find a new one.');
      }
    }
  });

  socket.on('disconnect', () => {
    state.wasDisconnected = true;
    el.banner.hidden = false;
    el.btnFind.disabled = true;
    el.stats.textContent = 'Reconnecting to server…';
  });

  socket.on('connect_error', () => {
    el.banner.hidden = false;
    el.btnFind.disabled = true;
  });

  socket.on('stats', (s) => {
    const players = `${s.online} ${s.online === 1 ? 'player' : 'players'} online`;
    const searching = s.in_queue > 0 ? `, ${s.in_queue} searching for a match` : '';
    el.stats.textContent = `${players}${searching}.`;
  });

  socket.on('error_message', (p) => {
    toast(p && p.message ? p.message : 'Something went wrong.');
    if (state.screen === 'home') el.btnFind.disabled = !socket.connected;
  });

  socket.on('queue_joined', () => {
    showScreen('queue');
    announce('Searching for an opponent');
  });

  socket.on('queue_left', () => {
    showScreen('home');
  });

  socket.on('match_found', (p) => {
    state.inMatch = true;
    state.roundsToWin = p.rounds_to_win || 2;
    state.signalAt = null;

    el.youName.textContent = p.you;
    el.oppName.textContent = p.opponent;
    el.roundLabel.textContent = 'Round 1';
    setScores(0, 0);

    hideFinal();
    hideRoundCard();
    setPhase('idle');
    setStage({ kicker: 'Match found. You are playing', main: p.opponent, sub: 'Get your finger ready' });
    showScreen('arena');
    announce(`Match found against ${p.opponent}`);
  });

  socket.on('countdown', (p) => {
    if (!state.inMatch) return;
    hideRoundCard();
    state.signalAt = null;
    el.roundLabel.textContent = `Round ${p.round}`;
    setPhase('countdown');
    setStage({
      kicker: p.replay ? 'Replaying the round. Get ready' : 'Get ready',
      main: String(p.count),
      sub: '',
    });
    popMain();
    if (p.count === 3) announce(`Round ${p.round}. Get ready`);
  });

  socket.on('get_set', () => {
    if (!state.inMatch) return;
    state.signalAt = null;
    setPhase('wait');
    setStage({ kicker: '', main: 'Wait for green…', sub: 'Tap early and you lose the round' });
    announce('Wait for green');
  });

  socket.on('tap_now', () => {
    if (!state.inMatch || state.phase !== 'wait') return;
    state.signalAt = null;
    setPhase('go');
    setStage({ kicker: '', main: 'TAP NOW!', sub: '' });
    requestAnimationFrame(() => {
      state.signalAt = performance.now();
    });
    if (navigator.vibrate) navigator.vibrate(40);
  });

  socket.on('round_result', (r) => {
    if (!state.inMatch) return;
    setScores(r.scores.you, r.scores.opponent);
    setPhase('result');
    setStage();
    showRoundResult(r);
  });

  socket.on('match_over', (m) => {
    if (!state.inMatch) return;
    state.inMatch = false;
    showFinal(m);
  });

  setScores(0, 0);
})();
