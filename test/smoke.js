'use strict';
// Röktest utan beroenden: node test/smoke.js
// Startar servern i mock-läge på en ledig port och kör hela flödet via HTTP.
// Inga anrop görs mot OpenAI eller något annat nätverk: global fetch ersätts av en attrapp
// i de delar som provar språkmodellvägen.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.AI_MODE = 'mock';
process.env.MOCK_DELAY_MS = '0';
delete process.env.TEACHER_PIN;
delete process.env.OPENAI_API_KEY;

const realFetch = globalThis.fetch;
const { start } = require('../server');
const ai = require('../lib/ai');

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok  ${name}`);
}

let base;
async function call(method, url, body) {
  const res = await realFetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}
const get = (u) => call('GET', u);
const post = (u, b) => call('POST', u, b || {});

// Läser första SSE-händelsen (aktuell vy) och stänger anslutningen.
async function view(room, token) {
  const ctrl = new AbortController();
  const res = await realFetch(`${base}/api/rooms/${room}/events?token=${token}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/^data: (.*)$/m);
    if (m) {
      ctrl.abort();
      return { raw: m[1], v: JSON.parse(m[1]) };
    }
  }
  throw new Error('Ingen SSE-händelse');
}

async function until(fn, what) {
  for (let i = 0; i < 100; i++) {
    const r = await fn();
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 20));
  }
  throw new Error('Tidsgräns: ' + what);
}

async function playRound(classCode, questions, { finishWithGuess = true } = {}) {
  const r = await post('/api/rooms', { classCode });
  assert.equal(r.status, 201);
  const { roomCode, token: askT } = r.data;
  const j = await post(`/api/rooms/${roomCode}/join`);
  assert.equal(j.status, 200);
  const ansT = j.data.token;
  for (const q of questions) {
    const a = await post(`/api/rooms/${roomCode}/ask`, { token: askT, text: q });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    await until(async () => (await view(roomCode, ansT)).v.mustAnswer, 'svararen ska få frågan');
    const s = await post(`/api/rooms/${roomCode}/answer`, { token: ansT, text: 'mitt svar på ' + q });
    assert.equal(s.status, 200);
    await until(async () => {
      const v = (await view(roomCode, askT)).v;
      return v.phase !== 'chat' || v.canAsk;
    }, 'båda svaren ska finnas');
  }
  return { roomCode, askT, ansT };
}

async function main() {
  const server = start(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Server på ${base} (AI-läge: ${ai.getAiMode()})`);

  // ---- statiska sidor ----
  for (const p of ['/', '/larare', '/style.css', '/app.js', '/larare.js', '/common.js', '/config.js', '/larare.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await get('/finns-inte.html')).status, 404);
  assert.equal((await get('/..%2fserver.js')).status, 404);
  ok('/ , /larare och statiska filer svarar 200; okänd sökväg och sökvägsklättring ger 404');

  const health = await get('/api/health');
  assert.equal(health.data.ok, true);
  assert.equal(health.data.aiMode, 'mock');
  ok('/api/health rapporterar mock-läge');

  // ---- klass ----
  const c = await post('/api/classes', { mode: 'chattbot', maxTurns: 3, timeLimitSec: 0 });
  assert.equal(c.status, 201);
  const { classCode, teacherKey } = c.data;
  assert.equal(c.data.settings.mode, 'chattbot');
  assert.equal((await get(`/api/classes/${classCode}?key=fel`)).status, 403);
  assert.equal((await post('/api/classes', { mode: 'finns-inte' })).status, 400);
  assert.equal((await post('/api/rooms', { classCode: 'ZZZZZ' })).status, 404);
  ok('klass skapas; fel nyckel ger 403; okänt läge 400; okänd klasskod 404');

  // ---- helt flöde: 3 frågor -> motivering -> avslöjande ----
  const { roomCode, askT, ansT } = await playRound(classCode, ['Hur mår du?', 'Vad gillar du?', 'Vad är meningen med livet?']);
  const gv = await view(roomCode, askT);
  assert.equal(gv.v.phase, 'guess');
  assert.equal(gv.v.turns.length, 3);
  assert.ok(gv.v.turns.every((t) => typeof t.A === 'string' && typeof t.B === 'string'));
  assert.ok(!('reveal' in gv.v));
  assert.ok(!/aiSlot/.test(gv.raw), 'frågarens vy får inte avslöja aiSlot före gissning');
  ok('efter 3 turer är fasen "guess" och frågaren ser bara A/B utan facit');

  const early = await post(`/api/rooms/${roomCode}/guess`, { token: askT, choice: 'A' });
  assert.equal(early.status, 400);
  const empty = await post(`/api/rooms/${roomCode}/guess`, { token: askT, choice: 'A', motivation: '   ' });
  assert.equal(empty.status, 400);
  const short = await post(`/api/rooms/${roomCode}/guess`, { token: askT, choice: 'A', motivation: 'ja' });
  assert.equal(short.status, 400);
  assert.notEqual((await view(roomCode, askT)).v.phase, 'reveal');
  assert.equal((await post(`/api/rooms/${roomCode}/guess`, { token: ansT, choice: 'A', motivation: 'svararen får inte gissa' })).status, 403);
  ok('avslöjandet nekas utan motivering (saknas, tom, för kort) och för svararen');

  const g = await post(`/api/rooms/${roomCode}/guess`, { token: askT, choice: 'A', motivation: 'A lät för artig och perfekt.' });
  assert.equal(g.status, 200);
  const rv = (await view(roomCode, askT)).v;
  assert.equal(rv.phase, 'reveal');
  assert.equal(rv.reveal.mode, 'chattbot');
  assert.equal(rv.reveal.transcript.length, 3);
  assert.equal(rv.reveal.correct, rv.reveal.aiSlot === 'A');
  ok('med motivering avslöjas AI-platsen och hela samtalet');

  // ---- lärarstatistik ----
  const st = await get(`/api/classes/${classCode}?key=${teacherKey}`);
  assert.equal(st.data.stats.total.guesses, 1);
  assert.equal(st.data.stats.byMode.chattbot.guesses, 1);
  assert.equal(st.data.stats.byMode.eliza.guesses, 0);
  assert.equal(st.data.motivations.length, 1);
  assert.ok(!('room' in st.data) && !/token/i.test(st.text), 'statistiken ska vara anonym');
  ok('lärarvyn räknar gissningen under rätt läge och innehåller ingen elev- eller rumsinformation');

  // ---- byte av läge mitt i lektionen + motiveringar ----
  const sw = await post(`/api/classes/${classCode}/settings`, { key: teacherKey, mode: 'eliza' });
  assert.equal(sw.data.settings.mode, 'eliza');
  assert.equal((await post(`/api/classes/${classCode}/settings`, { key: teacherKey, maxTurns: 99 })).status, 400);
  const mid = sw.data.motivations[0].id;
  const hid = await post(`/api/classes/${classCode}/motivation`, { key: teacherKey, id: mid, hidden: true });
  assert.equal(hid.data.motivations[0].text, null);
  ok('läraren byter läge; ogiltigt antal frågor nekas; motivering kan döljas');

  // ---- ELIZA: inga AI-anrop ----
  const savedEnv = { ...process.env };
  process.env.AI_MODE = 'openai';
  process.env.OPENAI_API_KEY = 'test-nyckel-inte-riktig';
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('Nätverksanrop blockerat av testet'); };
  const el = await playRound(classCode, ['Jag känner mig trött', 'Är du en dator?']);
  const ev = (await view(el.roomCode, el.askT)).v;
  assert.equal(ev.aiMode, 'lokal');
  assert.equal(fetchCalls, 0, 'ELIZA får inte göra något nätverksanrop');
  assert.equal((await post(`/api/rooms/${el.roomCode}/finish`, { token: el.askT })).status, 200);
  const gr = await post(`/api/rooms/${el.roomCode}/guess`, { token: el.askT, choice: 'B', motivation: 'B ställde bara frågor tillbaka.' });
  assert.equal(gr.status, 200);
  const elizaText = (await view(el.roomCode, el.askT)).v.reveal.transcript[0].ai;
  assert.ok(/trött/i.test(elizaText), 'ELIZA ska svara utifrån frågan: ' + elizaText);
  assert.equal((await get(`/api/classes/${classCode}?key=${teacherKey}`)).data.stats.byMode.eliza.guesses, 1);
  ok(`ELIZA-läget svarar ("${elizaText}") med 0 nätverksanrop även när AI_MODE=openai`);

  // ---- språkmodellvägen mot attrapp (ingen riktig OpenAI) ----
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'attrappsvar från modellen' } }] }) };
  };
  await post(`/api/classes/${classCode}/settings`, { key: teacherKey, mode: 'gymnasieelev' });
  process.env.AI_MODEL = 'test-modell-v1';
  delete process.env.OPENAI_MODEL;
  const lm = await playRound(classCode, ['Vad gör du på helgen?']);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith('/chat/completions'));
  const sent = JSON.parse(seen[0].init.body);
  assert.equal(sent.model, 'test-modell-v1', 'AI_MODEL (v1-namn) ska användas som reserv');
  assert.match(sent.messages[0].content, /gymnasieelev/);
  ok('språkmodellläget anropar (attrapp) chat/completions med modell från AI_MODEL och persona-prompt');

  // ---- v1-kompatibilitet ----
  for (const k of ['AI_MODE', 'OPENAI_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'OPENAI_MODEL']) delete process.env[k];
  process.env.AI_PROVIDER = 'openai';
  assert.equal(ai.getAiMode(), 'openai');
  process.env.AI_PROVIDER = 'none';
  process.env.OPENAI_API_KEY = 'x';
  assert.equal(ai.getAiMode(), 'mock');
  process.env.AI_MODE = 'openai';
  assert.equal(ai.getAiMode(), 'openai', 'AI_MODE har företräde');
  delete process.env.AI_MODE; delete process.env.AI_PROVIDER; delete process.env.OPENAI_API_KEY;
  assert.equal(ai.getAiMode(), 'mock');
  process.env.AI_MODEL = 'm1';
  assert.equal(ai.getModel(), 'm1');
  process.env.OPENAI_MODEL = 'm2';
  assert.equal(ai.getModel(), 'm2');
  ok('v1-namn (AI_PROVIDER, AI_MODEL) fungerar som reserv; AI_MODE/OPENAI_MODEL har företräde');

  Object.keys(process.env).forEach((k) => { if (!(k in savedEnv)) delete process.env[k]; });
  Object.assign(process.env, savedEnv);
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  server.closeAllConnections && server.closeAllConnections();
}

// Startar själva `node server.js --mock` som egen process och kontrollerar / och /larare.
function childCheck() {
  return new Promise((resolve, reject) => {
    const port = 3100 + Math.floor(Math.random() * 800);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AI_MODE: '', OPENAI_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Servern startade inte')); }, 8000);
    child.stdout.on('data', async (d) => {
      out += d;
      if (!/LYSSNAR/.test(out) || child.checked) return;
      child.checked = true;
      try {
        for (const p of ['/', '/larare']) {
          const r = await realFetch(`http://127.0.0.1:${port}${p}`);
          assert.equal(r.status, 200, p);
          assert.match(await r.text(), /<html/);
        }
        assert.match(out, /ai=mock/);
        ok('`node server.js --mock` startar som egen process och svarar 200 på / och /larare');
        clearTimeout(timer);
        child.kill();
        resolve();
      } catch (e) {
        clearTimeout(timer);
        child.kill();
        reject(e);
      }
    });
  });
}

main()
  .then(childCheck)
  .then(() => {
    console.log(`\nAlla ${passed} kontroller gick igenom.`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('\nMISSLYCKADES:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
