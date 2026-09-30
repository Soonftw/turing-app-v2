// Lärarsidan: skapa klass, välj/byt läge, se anonym statistik per läge. All text sätts med textContent.
'use strict';

const TEACHER_KEY = 'turing-v2-teacher';
let cls = null; // { code, key }
let view = null;
let pollTimer = null;
let editing = false; // true medan läraren ändrar inställningar, så att uppdateringen inte skriver över

const ORDER = ['gymnasieelev', 'chattbot', 'eliza'];
const DESC = {
  gymnasieelev: 'Språkmodell med instruktionen att låtsas vara en svensk gymnasieelev. Elevtexten skickas till OpenAI.',
  chattbot: 'Vanlig chattbot utan persona. Elevtexten skickas till OpenAI.',
  eliza: 'Regelbaserat program utan språkmodell. Inget skickas till någon AI-tjänst.',
  blandat: 'Varje nytt rum får slumpvis ett av de tre lägena. Elevtexten skickas till OpenAI i två av tre rum.',
};
const LABELS = {
  gymnasieelev: 'Gymnasieelev',
  chattbot: 'Vanlig chattbot',
  eliza: 'ELIZA (ingen språkmodell)',
  blandat: 'Blandat',
};

function fillModeSelect(sel) {
  sel.textContent = '';
  for (const m of [...ORDER, 'blandat']) {
    const o = el('option', null, LABELS[m]);
    o.value = m;
    sel.append(o);
  }
}

function setError(id, msg) {
  const p = $(id);
  p.textContent = msg || '';
  show(p, !!msg);
}

function saveCls(c) {
  cls = c;
  if (c) sessionStorage.setItem(TEACHER_KEY, JSON.stringify(c));
  else sessionStorage.removeItem(TEACHER_KEY);
}

function showCreate(msg) {
  clearTimeout(pollTimer);
  saveCls(null);
  view = null;
  show('view-class', false);
  show('view-create', true);
  setError('create-error', msg);
}

function pct(n, d) {
  return d ? `${Math.round((100 * n) / d)} %` : '–';
}

function renderStats() {
  const body = $('stat-body');
  body.textContent = '';
  const rows = [...ORDER.map((m) => [LABELS[m], view.stats.byMode[m]]), ['Alla lägen', view.stats.total]];
  rows.forEach(([name, s], i) => {
    const tr = el('tr');
    const last = i === rows.length - 1;
    const th = el(last ? 'th' : 'td', null, name);
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = s.guesses ? `${Math.round((100 * s.correct) / s.guesses)}%` : '0%';
    bar.append(fill);
    const barCell = el('td');
    barCell.append(bar);
    tr.append(th, el('td', 'num', String(s.guesses)), el('td', 'num', String(s.correct)), el('td', 'num', pct(s.correct, s.guesses)), barCell);
    body.append(tr);
  });
}

function renderMotivations() {
  const list = $('mot-list');
  list.textContent = '';
  $('btn-toggle-mot').textContent = view.showMotivations ? 'Dölj motiveringarna' : 'Visa motiveringarna';
  if (!view.showMotivations) {
    list.append(el('li', 'tag', `${view.motivations.length} motiveringar finns. De är dolda tills du väljer att visa dem.`));
    return;
  }
  if (!view.motivations.length) list.append(el('li', 'tag', 'Inga motiveringar ännu.'));
  for (const m of view.motivations) {
    const li = el('li', m.hidden ? 'hid' : '');
    li.append(el('div', 'tag', `${LABELS[m.mode] || m.mode} · ${m.correct ? 'gissade rätt' : 'gissade fel'}`));
    li.append(el('div', null, m.hidden ? '(dold)' : m.text));
    const b = el('button', 'link-button', m.hidden ? 'Visa igen' : 'Dölj');
    b.addEventListener('click', () => post('motivation', { id: m.id, hidden: !m.hidden }));
    li.append(b);
    list.append(li);
  }
}

function render(v) {
  view = v;
  show('view-create', false);
  show('view-class', true);
  show('banner-mock', v.aiMode === 'mock');
  $('class-code').textContent = v.classCode;
  $('teacher-key').textContent = cls.key;
  $('rooms-info').textContent = `Rum: ${v.rooms.active} pågår, ${v.rooms.created} skapade totalt.`;
  if (!editing) {
    $('set-mode').value = v.settings.mode;
    $('set-turns').value = v.settings.maxTurns;
    $('set-time').value = v.settings.timeLimitSec;
    $('mode-desc').textContent = DESC[v.settings.mode] || '';
  }
  renderStats();
  renderMotivations();
}

async function refresh() {
  clearTimeout(pollTimer);
  if (!cls) return;
  try {
    const v = await api(`/api/classes/${encodeURIComponent(cls.code)}?key=${encodeURIComponent(cls.key)}`);
    show('banner-conn', false);
    render(v);
  } catch (e) {
    if (e.status === 404 || e.status === 403) return showCreate(e.message);
    show('banner-conn', true);
  }
  pollTimer = setTimeout(refresh, 3000);
}

async function post(action, body) {
  try {
    const v = await api(`/api/classes/${encodeURIComponent(cls.code)}/${action}`, { key: cls.key, ...body });
    render(v);
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

function enterClass(code, key) {
  saveCls({ code, key });
  refresh();
}

function init() {
  fillModeSelect($('create-mode'));
  fillModeSelect($('set-mode'));

  $('btn-create').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    setError('create-error', '');
    try {
      const body = { mode: $('create-mode').value };
      if (!$('pin-row').hidden) body.pin = $('pin').value;
      const v = await api('/api/classes', body);
      $('pin').value = '';
      enterClass(v.classCode, v.teacherKey);
    } catch (e) {
      setError('create-error', e.message);
    } finally {
      ev.target.disabled = false;
    }
  });

  $('btn-resume').addEventListener('click', () => {
    const code = $('resume-code').value.trim().toUpperCase();
    const key = $('resume-key').value.trim();
    if (!code || !key) return setError('create-error', 'Skriv både klasskod och lärarnyckel.');
    setError('create-error', '');
    enterClass(code, key);
  });

  $('set-mode').addEventListener('change', () => {
    editing = true;
    $('mode-desc').textContent = DESC[$('set-mode').value] || '';
  });
  ['set-turns', 'set-time'].forEach((id) => $(id).addEventListener('input', () => { editing = true; }));

  $('btn-save').addEventListener('click', async () => {
    const ok = await post('settings', {
      mode: $('set-mode').value,
      maxTurns: Number($('set-turns').value),
      timeLimitSec: Number($('set-time').value),
    });
    if (ok) {
      editing = false;
      const m = $('save-msg');
      m.textContent = 'Sparat. Gäller nya rum.';
      show(m, true);
      setTimeout(() => show(m, false), 3000);
    }
  });

  $('btn-toggle-mot').addEventListener('click', () => post('show-motivations', { show: !view.showMotivations }));
  $('btn-reset').addEventListener('click', () => {
    if (confirm('Nollställa all statistik och alla motiveringar för klassen?')) post('reset', {});
  });
  $('btn-close').addEventListener('click', () => showCreate(''));

  wakeServer()
    .then((h) => {
      show('banner-mock', h.aiMode === 'mock');
      show('pin-row', !!h.teacherPinRequired);
    })
    .catch((e) => setError('create-error', e.message));

  const saved = sessionStorage.getItem(TEACHER_KEY);
  if (saved) {
    try {
      const c = JSON.parse(saved);
      if (c && c.code && c.key) enterClass(c.code, c.key);
    } catch {
      saveCls(null);
    }
  }
}

init();
