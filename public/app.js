// Elevsidan: frågare och svarare. All text sätts med textContent (ingen HTML från användare).
'use strict';

const SESSION_KEY = 'turing-v2-session';
let session = null; // { roomCode, token, role }
let es = null;
let state = null;
let localDeadline = null;
let chosen = null;
let reconnectTimer = null;

const MODE_EXPLANATIONS = {
  gymnasieelev: 'AI:n var en språkmodell med instruktionen att låtsas vara en svensk gymnasieelev: kort, vardagligt och med små stavfel.',
  chattbot: 'AI:n var en vanlig chattbot (språkmodell) utan någon instruktion att låtsas vara människa.',
  eliza: 'AI:n var en ELIZA-variant: ett regelbaserat program utan språkmodell. Det letar efter nyckelord och skriver om din mening enligt färdiga mallar. Idén kommer från Joseph Weizenbaums program ELIZA (1966). Programmet förstår ingenting av det du skriver.',
};

function saveSession(s) {
  session = s;
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}

function startError(msg) {
  const p = $('start-error');
  p.textContent = msg || '';
  show(p, !!msg);
}

function showStart(msg) {
  if (es) es.close();
  es = null;
  clearTimeout(reconnectTimer);
  saveSession(null);
  state = null;
  show('view-room', false);
  show('view-start', true);
  show('banner-conn', false);
  startError(msg);
}

function showRoom() {
  show('view-start', false);
  show('view-room', true);
  startError('');
}

// ---------- realtid (server-sent events) ----------
function connect() {
  if (es) es.close();
  clearTimeout(reconnectTimer);
  const url = `${SERVER}/api/rooms/${encodeURIComponent(session.roomCode)}/events?token=${encodeURIComponent(session.token)}`;
  es = new EventSource(url);
  es.onmessage = (ev) => {
    show('banner-conn', false);
    try {
      render(JSON.parse(ev.data));
    } catch {
      /* ignorera trasiga meddelanden */
    }
  };
  es.onerror = () => {
    show('banner-conn', true);
    if (es.readyState === EventSource.CLOSED) {
      // Webbläsaren har gett upp. Kontrollera om rummet finns kvar.
      reconnectTimer = setTimeout(checkRoom, 2000);
    }
  };
}

async function checkRoom() {
  if (!session) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(session.roomCode)}/status?token=${encodeURIComponent(session.token)}`);
    connect();
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      showStart('Rummet finns inte längre (servern kan ha startats om). Starta en ny omgång.');
    } else {
      reconnectTimer = setTimeout(checkRoom, 3000);
    }
  }
}

// ---------- rendering ----------
function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderStatus() {
  if (!state) return;
  const parts = [`Rum ${state.roomCode}`, state.role === 'asker' ? 'Du är frågare' : 'Du är svarare'];
  if (state.phase === 'chat') {
    parts.push(`Fråga ${Math.min(state.turnsDone + 1, state.maxTurns)} av ${state.maxTurns}`);
    if (localDeadline) {
      const left = localDeadline - Date.now();
      parts.push(left > 0 ? `${fmtTime(left)} kvar` : 'Tiden är slut');
    }
  }
  $('room-status').textContent = parts.join(' · ');
}

function renderInfo() {
  const box = $('room-info');
  box.textContent = '';
  if (state.role === 'asker') {
    if (state.phase === 'waiting') {
      box.append(el('p', null, 'Ge rumskoden till din svarare:'), el('p', 'big-code', state.roomCode), el('p', null, 'Väntar på att svararen ska gå med …'));
    } else if (state.phase === 'chat') {
      box.append(el('p', null, 'Ställ frågor. Du får två svar, A och B. Den ena är din klasskamrat, den andra är en AI. A och B är samma person/AI genom hela samtalet.'));
    }
  } else {
    if (state.phase === 'chat') {
      box.append(el('p', null, 'Du är människan. Svara ärligt och som dig själv, men skriv inga personuppgifter. Frågaren ser ditt svar bredvid AI:ns och ska gissa vem som är vem.'));
    } else if (state.phase === 'guess') {
      box.append(el('p', null, 'Samtalet är slut. Frågaren funderar och gissar nu …'));
    }
  }
  show(box, box.childNodes.length > 0);
}

function renderChat() {
  const list = $('chat');
  list.textContent = '';
  const transcriptMode = state.phase === 'reveal';
  if (transcriptMode) return; // avslöjandet visar hela samtalet med etiketter
  state.turns.forEach((t, i) => {
    const li = el('li', 'turn');
    li.append(el('p', 'question', `Fråga ${i + 1}: ${t.question}`));
    if (state.role === 'asker') {
      if (t.pending) {
        li.append(el('p', 'wait', 'Väntar på svar från A och B …'));
      } else {
        const grid = el('div', 'answers');
        for (const slot of ['A', 'B']) {
          const box = el('div', `answer slot-${slot}`);
          box.append(el('span', 'label', slot), el('p', null, t[slot]));
          grid.append(box);
        }
        li.append(grid);
      }
    } else {
      if (t.mine !== null) li.append(el('p', 'mine', `Ditt svar: ${t.mine}`));
      else if (t.pending) li.append(el('p', 'wait', 'Skriv ditt svar nedan.'));
    }
    list.append(li);
  });
}

function renderForms() {
  const asker = state.role === 'asker';
  show('ask-form', asker && state.phase === 'chat');
  if (asker && state.phase === 'chat') {
    $('ask-form').querySelector('button[type=submit]').disabled = !state.canAsk;
    $('ask-text').disabled = !state.canAsk;
    $('ask-text').placeholder = state.canAsk ? 'Skriv en fråga …' : 'Väntar på svar …';
    $('btn-finish').disabled = !state.canFinish;
  }
  show('answer-form', !asker && state.mustAnswer);
  show('guess-form', asker && state.phase === 'guess');
  if (!asker && state.mustAnswer) $('answer-text').focus();
}

function renderReveal() {
  const box = $('reveal');
  box.textContent = '';
  if (state.phase !== 'reveal' || !state.reveal) {
    show(box, false);
    return;
  }
  const r = state.reveal;
  const asker = state.role === 'asker';
  const headline = asker
    ? r.correct ? 'Rätt! Du hittade AI:n.' : 'Fel – AI:n lurade dig.'
    : r.correct ? 'Frågaren gissade rätt och hittade AI:n.' : 'Frågaren gissade fel – du togs för AI:n!';
  box.append(el('h2', r.correct ? 'result ok' : 'result miss', headline));
  box.append(el('p', null, `AI:n var ${r.aiSlot}. Frågaren gissade på ${r.choice}.`));
  box.append(el('p', null, `Läge: ${r.modeLabel}.`));
  box.append(el('p', 'explain', MODE_EXPLANATIONS[r.mode] || ''));
  box.append(el('p', 'motivation', `Frågarens motivering: ”${r.motivation}”`));

  box.append(el('h3', null, 'Hela samtalet'));
  const list = el('ol', 'chat');
  r.transcript.forEach((t, i) => {
    const li = el('li', 'turn');
    li.append(el('p', 'question', `Fråga ${i + 1}: ${t.question}`));
    const grid = el('div', 'answers');
    const human = el('div', 'answer human');
    human.append(el('span', 'label', `${r.aiSlot === 'A' ? 'B' : 'A'} · människa`), el('p', null, t.human));
    const aiBox = el('div', 'answer ai');
    aiBox.append(el('span', 'label', `${r.aiSlot} · AI`), el('p', null, t.ai));
    if (r.aiSlot === 'A') grid.append(aiBox, human);
    else grid.append(human, aiBox);
    li.append(grid);
    list.append(li);
  });
  box.append(list);

  box.append(el('h3', null, 'Fundera och diskutera'));
  const ul = el('ul');
  ['Vad avslöjade AI:n – eller vad fick den att verka mänsklig?', 'Vad fick människan att verka som en maskin?', 'Visar ett lyckat Turingtest att maskinen tänker eller förstår? Varför, eller varför inte?'].forEach((q) => ul.append(el('li', null, q)));
  box.append(ul);

  const again = el('button', 'big primary', 'Ny omgång');
  again.addEventListener('click', () => showStart(''));
  box.append(again);
  show(box, true);
}

function render(s) {
  const prevPhase = state && state.phase;
  state = s;
  showRoom();
  localDeadline = s.remainingMs !== null && s.remainingMs !== undefined ? Date.now() + s.remainingMs : null;
  show('banner-mock', s.aiMode === 'mock');
  const n = $('notice');
  if (s.notice) {
    n.textContent = s.notice;
    show(n, true);
  } else if (prevPhase !== s.phase) {
    show(n, false);
  }
  renderStatus();
  renderInfo();
  renderChat();
  renderForms();
  renderReveal();
  updateCounters();
  $('btn-leave').textContent = s.phase === 'reveal' ? 'Tillbaka till start' : 'Lämna rummet';
}

// ---------- teckenräknare ----------
function updateCounters() {
  if (!state) return;
  const lim = state.limits;
  $('ask-count').textContent = `${$('ask-text').value.length}/${lim.maxMessageLength}`;
  $('answer-count').textContent = `${$('answer-text').value.length}/${lim.maxMessageLength}`;
  const mlen = $('motivation').value.trim().length;
  $('motivation-count').textContent = mlen < lim.minMotivationLength
    ? `minst ${lim.minMotivationLength} tecken (${mlen})`
    : `${mlen}/${lim.maxMotivationLength}`;
  $('ask-text').maxLength = lim.maxMessageLength;
  $('answer-text').maxLength = lim.maxMessageLength;
  $('motivation').maxLength = lim.maxMotivationLength;
}

function flash(msg) {
  const n = $('notice');
  n.textContent = msg;
  show(n, true);
}

// ---------- händelser ----------
async function roomPost(action, body, btn) {
  if (btn) btn.disabled = true;
  try {
    return await api(`/api/rooms/${encodeURIComponent(session.roomCode)}/${action}`, { token: session.token, ...body });
  } catch (e) {
    flash(e.message);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function init() {
  $('btn-create').addEventListener('click', async (ev) => {
    const code = $('class-code').value.trim();
    if (!code) return startError('Skriv klasskoden som läraren visar.');
    ev.target.disabled = true;
    try {
      const r = await api('/api/rooms', { classCode: code });
      saveSession({ roomCode: r.roomCode, token: r.token, role: r.role });
      connect();
    } catch (e) {
      startError(e.message);
    } finally {
      ev.target.disabled = false;
    }
  });

  $('btn-join').addEventListener('click', async (ev) => {
    const code = $('room-code').value.trim();
    if (!code) return startError('Skriv rumskoden som frågaren visar.');
    ev.target.disabled = true;
    try {
      const r = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {});
      saveSession({ roomCode: r.roomCode, token: r.token, role: r.role });
      connect();
    } catch (e) {
      startError(e.message);
    } finally {
      ev.target.disabled = false;
    }
  });

  $('ask-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('ask-text').value.trim();
    if (!text) return;
    const ok = await roomPost('ask', { text }, ev.submitter);
    if (ok) $('ask-text').value = '';
    updateCounters();
  });

  $('btn-finish').addEventListener('click', async (ev) => {
    if (!confirm('Vill du sluta ställa frågor och gå till gissningen?')) return;
    await roomPost('finish', {}, ev.target);
  });

  $('answer-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('answer-text').value.trim();
    if (!text) return;
    const ok = await roomPost('answer', { text }, ev.submitter);
    if (ok) $('answer-text').value = '';
    updateCounters();
  });

  document.querySelectorAll('.choice').forEach((b) =>
    b.addEventListener('click', () => {
      chosen = b.dataset.choice;
      document.querySelectorAll('.choice').forEach((x) => x.classList.toggle('selected', x === b));
    })
  );

  $('guess-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!chosen) return flash('Välj A eller B först.');
    const motivation = $('motivation').value.trim();
    if (motivation.length < state.limits.minMotivationLength) {
      return flash(`Skriv en lite längre motivering (minst ${state.limits.minMotivationLength} tecken).`);
    }
    const ok = await roomPost('guess', { choice: chosen, motivation }, ev.submitter);
    if (ok) {
      $('motivation').value = '';
      chosen = null;
      document.querySelectorAll('.choice').forEach((x) => x.classList.remove('selected'));
    }
  });

  ['ask-text', 'answer-text', 'motivation'].forEach((id) => $(id).addEventListener('input', updateCounters));
  ['class-code', 'room-code'].forEach((id) =>
    $(id).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') $(id === 'class-code' ? 'btn-create' : 'btn-join').click();
    })
  );
  // Enter skickar, Skift+Enter ger ny rad.
  ['ask-text', 'answer-text'].forEach((id) =>
    $(id).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        $(id).form.requestSubmit();
      }
    })
  );

  $('btn-leave').addEventListener('click', () => {
    if (state && state.phase !== 'reveal' && !confirm('Vill du lämna rummet? Du kan inte komma tillbaka in.')) return;
    showStart('');
  });

  setInterval(renderStatus, 1000);

  // Väck servern direkt, och återanslut om sidan laddades om mitt i en omgång.
  wakeServer()
    .then((h) => show('banner-mock', h.aiMode === 'mock'))
    .catch((e) => startError(e.message));
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      session = JSON.parse(saved);
      checkRoom();
    } catch {
      saveSession(null);
    }
  }
}

init();
