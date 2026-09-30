'use strict';
// Turingtestet v2 – server med bara Node och standardbiblioteket (inga npm-paket).
// Allt hålls i minnet. Inget chattinnehåll skrivs till loggen eller till disk.

if (process.argv.includes('--mock')) process.env.AI_MODE = 'mock';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./lib/config');
const ai = require('./lib/ai');
const { createEliza } = require('./lib/eliza');

const VERSION = '2.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODES = ['gymnasieelev', 'chattbot', 'eliza'];
const CLASS_MODES = [...MODES, 'blandat'];
const MODE_LABELS = {
  gymnasieelev: 'Gymnasieelev (språkmodell som låtsas vara elev)',
  chattbot: 'Vanlig chattbot (språkmodell utan persona)',
  eliza: 'ELIZA (regelbaserat program, ingen språkmodell)',
  blandat: 'Blandat (slumpas för varje rum)',
};
const DEFAULT_SETTINGS = { mode: 'gymnasieelev', maxTurns: 5, timeLimitSec: 180 };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const classes = new Map();
const rooms = new Map();
const globalAiCalls = [];
const pinFailures = [];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- hjälpfunktioner ----------
const now = () => Date.now();
const newToken = () => crypto.randomBytes(16).toString('hex');
const normCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomCode(len, taken) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < len; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
  throw new HttpError(503, 'Kunde inte skapa en ny kod. Försök igen.');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function cleanText(value, max, field) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} saknas.`);
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .trim();
  if (!text) throw new HttpError(400, `${field} är tom.`);
  if (text.length > max) throw new HttpError(400, `${field} är för lång (max ${max} tecken).`);
  return text;
}

function prune(arr, t) {
  while (arr.length && t - arr[0] > 60000) arr.shift();
}

function parseSettings(body, base) {
  const s = { ...base };
  if (body.mode !== undefined) {
    if (!CLASS_MODES.includes(body.mode)) throw new HttpError(400, 'Okänt svarsläge.');
    s.mode = body.mode;
  }
  if (body.maxTurns !== undefined) {
    const n = Number(body.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new HttpError(400, 'Antal frågor ska vara 1–10.');
    s.maxTurns = n;
  }
  if (body.timeLimitSec !== undefined) {
    const n = Number(body.timeLimitSec);
    if (!Number.isInteger(n) || !(n === 0 || (n >= 3 && n <= 900))) {
      throw new HttpError(400, 'Tidsgränsen ska vara 0 (ingen) eller 3–900 sekunder.');
    }
    s.timeLimitSec = n;
  }
  return s;
}

// ---------- klasser (lärarvyn) ----------
function emptyStats() {
  return Object.fromEntries(MODES.map((m) => [m, { guesses: 0, correct: 0 }]));
}

function getClassForTeacher(code, key) {
  const cls = classes.get(normCode(code));
  if (!cls) throw new HttpError(404, 'Klassen finns inte (servern kan ha startats om). Skapa en ny klass.');
  if (typeof key !== 'string' || !safeEqual(key, cls.teacherKey)) throw new HttpError(403, 'Fel lärarnyckel.');
  cls.lastActive = now();
  return cls;
}

function classView(cls) {
  let guesses = 0;
  let correct = 0;
  for (const m of MODES) {
    guesses += cls.stats[m].guesses;
    correct += cls.stats[m].correct;
  }
  let active = 0;
  for (const r of rooms.values()) if (r.classCode === cls.code && r.phase !== 'reveal') active++;
  return {
    classCode: cls.code,
    settings: cls.settings,
    modeLabels: MODE_LABELS,
    aiMode: ai.getAiMode(),
    stats: { total: { guesses, correct }, byMode: cls.stats },
    rooms: { active, created: cls.roomsCreated },
    showMotivations: cls.showMotivations,
    motivations: cls.motivations.map((m) => ({
      id: m.id,
      mode: m.mode,
      correct: m.correct,
      hidden: m.hidden,
      text: m.hidden ? null : m.text,
    })),
  };
}

// ---------- rum ----------
function getRoom(code) {
  const room = rooms.get(normCode(code));
  if (!room) throw new HttpError(404, 'Rummet finns inte längre. Starta en ny omgång.');
  room.lastActive = now();
  return room;
}

function roleOf(room, token) {
  if (typeof token !== 'string' || !token) return null;
  if (safeEqual(token, room.askerToken)) return 'asker';
  if (room.responderToken && safeEqual(token, room.responderToken)) return 'responder';
  return null;
}

function requireRole(room, token, wanted) {
  const role = roleOf(room, token);
  if (!role) throw new HttpError(403, 'Du är inte med i det här rummet.');
  if (wanted && role !== wanted) {
    throw new HttpError(403, wanted === 'asker' ? 'Bara frågaren kan göra det.' : 'Bara svararen kan göra det.');
  }
  return role;
}

const doneTurns = (room) => room.turns.filter((t) => t.done).length;
function pendingTurn(room) {
  const t = room.turns[room.turns.length - 1];
  return t && !t.done ? t : null;
}
function canAsk(room) {
  return (
    room.phase === 'chat' &&
    !pendingTurn(room) &&
    room.turns.length < room.maxTurns &&
    !(room.timeUp && doneTurns(room) > 0)
  );
}

function setNotice(room, who, text) {
  if (who === 'asker' || who === 'both') room.notices.asker = text;
  if (who === 'responder' || who === 'both') room.notices.responder = text;
}

function viewFor(room, role) {
  const v = {
    roomCode: room.code,
    role,
    phase: room.phase,
    maxTurns: room.maxTurns,
    turnsDone: doneTurns(room),
    timeLimitSec: room.timeLimitSec,
    remainingMs: room.deadline && room.phase === 'chat' ? Math.max(0, room.deadline - now()) : null,
    timeUp: room.timeUp,
    aiMode: room.mode === 'eliza' ? 'lokal' : ai.getAiMode(),
    notice: room.notices[role] || null,
    limits: {
      maxMessageLength: cfg.maxMessageLength,
      maxMotivationLength: cfg.maxMotivationLength,
      minMotivationLength: cfg.minMotivationLength,
    },
  };
  const pending = pendingTurn(room);
  if (role === 'asker') {
    // Frågaren ser aldrig vem som är vem – bara A och B, och först när båda har svarat.
    v.turns = room.turns.map((t) =>
      t.done
        ? {
            question: t.question,
            A: room.aiSlot === 'A' ? t.ai : t.human,
            B: room.aiSlot === 'A' ? t.human : t.ai,
          }
        : { question: t.question, pending: true }
    );
    v.canAsk = canAsk(room);
    v.canFinish = room.phase === 'chat' && doneTurns(room) > 0;
  } else {
    // Svararen ser bara frågorna och sina egna svar.
    v.turns = room.turns.map((t) => ({ question: t.question, mine: t.human, pending: !t.done }));
    v.mustAnswer = room.phase === 'chat' && !!pending && pending.human === null;
  }
  if (room.phase === 'reveal' && room.guess) {
    v.reveal = {
      aiSlot: room.aiSlot,
      choice: room.guess.choice,
      correct: room.guess.correct,
      motivation: room.guess.motivation,
      mode: room.mode,
      modeLabel: MODE_LABELS[room.mode],
      transcript: room.turns.filter((t) => t.done).map((t) => ({ question: t.question, human: t.human, ai: t.ai })),
    };
  }
  return v;
}

function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room) {
  for (const client of room.clients) sendEvent(client.res, viewFor(room, client.role));
  room.notices.asker = null;
  room.notices.responder = null;
}

function toGuess(room, notice) {
  room.phase = 'guess';
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  if (notice) setNotice(room, 'both', notice);
  broadcast(room);
}

function onDeadline(room) {
  room.timer = null;
  if (!rooms.has(room.code) || room.phase !== 'chat') return;
  room.timeUp = true;
  if (!pendingTurn(room) && doneTurns(room) > 0) toGuess(room, 'Tiden är slut – dags att gissa!');
  else broadcast(room);
}

function checkTurnDone(room, turn) {
  if (turn.done || turn.human === null || turn.ai === null) {
    broadcast(room);
    return;
  }
  turn.done = true;
  if (doneTurns(room) >= room.maxTurns) return toGuess(room, 'Alla frågor är ställda – dags att gissa!');
  if (room.timeUp) return toGuess(room, 'Tiden är slut – dags att gissa!');
  broadcast(room);
}

function checkAndCountAiCall(room) {
  const t = now();
  prune(room.aiCallTimes, t);
  prune(globalAiCalls, t);
  if (room.aiCallsTotal >= cfg.aiPerRoomTotal) {
    throw new HttpError(429, 'Rummet har nått maxantalet AI-frågor. Gå vidare till gissningen.');
  }
  if (room.aiCallTimes.length >= cfg.aiPerRoomPerMinute) {
    throw new HttpError(429, `Max ${cfg.aiPerRoomPerMinute} frågor per minut i ett rum. Vänta en stund och försök igen.`);
  }
  if (globalAiCalls.length >= cfg.aiGlobalPerMinute) {
    throw new HttpError(429, 'Väldigt många frågor i hela klassen just nu. Vänta en halv minut och försök igen.');
  }
  room.aiCallTimes.push(t);
  globalAiCalls.push(t);
  room.aiCallsTotal++;
}

function tidyAnswer(text) {
  return String(text).replace(/\n{3,}/g, '\n\n').trim().slice(0, 600);
}

async function produceAiAnswer(room, turn) {
  let answer;
  try {
    if (room.mode === 'eliza') {
      answer = room.eliza.reply(turn.question);
    } else {
      const history = [];
      for (const t of room.turns) {
        if (t === turn) break;
        if (t.done) history.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.ai });
      }
      history.push({ role: 'user', content: turn.question });
      answer = await ai.generate(room.mode, history);
    }
    answer = tidyAnswer(answer);
  } catch (err) {
    // Logga bara typ av fel, aldrig innehåll.
    console.warn(`[ai] AI-anrop misslyckades (läge ${room.mode}, ${err && err.status ? 'status ' + err.status : err && err.name})`);
    if (!rooms.has(room.code) || !room.turns.includes(turn)) return;
    room.turns.splice(room.turns.indexOf(turn), 1);
    setNotice(room, 'both', 'AI-tjänsten svarade inte. Frågan togs bort – ställ den igen eller en ny.');
    if (room.timeUp && doneTurns(room) > 0) toGuess(room);
    else broadcast(room);
    return;
  }
  if (!rooms.has(room.code) || !room.turns.includes(turn)) return;
  turn.ai = answer;
  checkTurnDone(room, turn);
}

function deleteRoom(room) {
  if (room.timer) clearTimeout(room.timer);
  for (const c of room.clients) {
    try {
      c.res.end();
    } catch {
      /* ignorera */
    }
  }
  room.clients.clear();
  rooms.delete(room.code);
}

// ---------- HTTP ----------
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (cfg.allowedOrigins.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (cfg.allowedOrigins.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  return {};
}

function json(req, res, status, obj) {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16384) {
        reject(new HttpError(413, 'För stort meddelande.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Ogiltig förfrågan.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'Avbruten förfrågan.')));
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Sidan finns inte.');
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  if (pathname === '/larare/') {
    res.writeHead(301, { Location: '/larare' });
    return res.end();
  }
  const rel = pathname === '/' ? '/index.html' : pathname === '/larare' ? '/larare.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return notFound(res);
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function handleEvents(req, res, room, role) {
  res.writeHead(200, {
    ...corsHeaders(req),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, role };
  room.clients.add(client);
  sendEvent(res, viewFor(room, role));
  req.on('close', () => room.clients.delete(client));
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  let m;

  if (req.method === 'GET' && p === '/api/health') {
    return json(req, res, 200, {
      ok: true,
      version: VERSION,
      aiMode: ai.getAiMode(),
      teacherPinRequired: !!cfg.teacherPin,
    });
  }

  // --- lärare ---
  if (req.method === 'POST' && p === '/api/classes') {
    const body = await readBody(req);
    if (cfg.teacherPin) {
      const t = now();
      prune(pinFailures, t);
      if (pinFailures.length >= 10) throw new HttpError(429, 'För många felaktiga försök. Vänta en minut.');
      if (!safeEqual(String(body.pin || ''), cfg.teacherPin)) {
        pinFailures.push(t);
        throw new HttpError(403, 'Fel lärar-PIN.');
      }
    }
    if (classes.size >= cfg.maxClasses) throw new HttpError(503, 'Servern har för många klasser just nu.');
    const settings = parseSettings(body, DEFAULT_SETTINGS);
    const cls = {
      code: randomCode(5, classes),
      teacherKey: newToken(),
      createdAt: now(),
      lastActive: now(),
      settings,
      stats: emptyStats(),
      motivations: [],
      nextMotivationId: 1,
      showMotivations: false,
      roomsCreated: 0,
    };
    classes.set(cls.code, cls);
    console.log(`[klass] Ny klass skapad (${classes.size} i minnet)`);
    return json(req, res, 201, { teacherKey: cls.teacherKey, ...classView(cls) });
  }

  if (req.method === 'GET' && (m = p.match(/^\/api\/classes\/([A-Za-z0-9]+)$/))) {
    const cls = getClassForTeacher(m[1], url.searchParams.get('key'));
    return json(req, res, 200, classView(cls));
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/classes\/([A-Za-z0-9]+)\/(settings|motivation|show-motivations|reset)$/))) {
    const body = await readBody(req);
    const cls = getClassForTeacher(m[1], body.key);
    if (m[2] === 'settings') {
      cls.settings = parseSettings(body, cls.settings);
    } else if (m[2] === 'motivation') {
      const item = cls.motivations.find((x) => x.id === Number(body.id));
      if (!item) throw new HttpError(404, 'Motiveringen finns inte.');
      item.hidden = !!body.hidden;
    } else if (m[2] === 'show-motivations') {
      cls.showMotivations = !!body.show;
    } else if (m[2] === 'reset') {
      cls.stats = emptyStats();
      cls.motivations = [];
    }
    return json(req, res, 200, classView(cls));
  }

  // --- elever ---
  if (req.method === 'POST' && p === '/api/rooms') {
    const body = await readBody(req);
    const cls = classes.get(normCode(body.classCode));
    if (!cls) throw new HttpError(404, 'Hittar ingen klass med den koden. Kontrollera klasskoden med läraren.');
    if (rooms.size >= cfg.maxRooms) throw new HttpError(503, 'Servern har för många rum just nu. Försök igen om en stund.');
    const mode = cls.settings.mode === 'blandat' ? MODES[crypto.randomInt(MODES.length)] : cls.settings.mode;
    const room = {
      code: randomCode(4, rooms),
      classCode: cls.code,
      mode,
      maxTurns: cls.settings.maxTurns,
      timeLimitSec: cls.settings.timeLimitSec,
      createdAt: now(),
      lastActive: now(),
      askerToken: newToken(),
      responderToken: null,
      aiSlot: crypto.randomInt(2) === 0 ? 'A' : 'B',
      phase: 'waiting',
      deadline: null,
      timeUp: false,
      timer: null,
      turns: [],
      nextTurnId: 1,
      aiCallTimes: [],
      aiCallsTotal: 0,
      eliza: mode === 'eliza' ? createEliza() : null,
      clients: new Set(),
      notices: { asker: null, responder: null },
      guess: null,
    };
    rooms.set(room.code, room);
    cls.roomsCreated++;
    cls.lastActive = now();
    return json(req, res, 201, { roomCode: room.code, token: room.askerToken, role: 'asker' });
  }

  if (req.method === 'GET' && (m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/(events|status)$/))) {
    const room = getRoom(m[1]);
    const role = requireRole(room, url.searchParams.get('token'));
    if (m[2] === 'status') return json(req, res, 200, { ok: true, phase: room.phase, role });
    return handleEvents(req, res, room, role);
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/(join|ask|answer|finish|guess)$/))) {
    const body = await readBody(req);
    const room = getRoom(m[1]);
    const action = m[2];

    if (action === 'join') {
      if (room.responderToken) throw new HttpError(409, 'Rummet har redan en svarare.');
      room.responderToken = newToken();
      room.phase = 'chat';
      if (room.timeLimitSec > 0) {
        room.deadline = now() + room.timeLimitSec * 1000;
        room.timer = setTimeout(() => onDeadline(room), room.timeLimitSec * 1000);
      }
      setNotice(room, 'asker', 'Svararen är här. Ställ din första fråga!');
      broadcast(room);
      return json(req, res, 200, { roomCode: room.code, token: room.responderToken, role: 'responder' });
    }

    if (action === 'ask') {
      requireRole(room, body.token, 'asker');
      if (room.phase === 'waiting') throw new HttpError(409, 'Vänta tills svararen har anslutit.');
      if (room.phase !== 'chat') throw new HttpError(409, 'Samtalet är slut.');
      if (pendingTurn(room)) throw new HttpError(409, 'Vänta på svaren på förra frågan.');
      if (room.turns.length >= room.maxTurns) throw new HttpError(409, 'Du har ställt alla frågor.');
      if (room.timeUp && doneTurns(room) > 0) throw new HttpError(409, 'Tiden är slut.');
      const text = cleanText(body.text, cfg.maxMessageLength, 'Frågan');
      if (room.mode !== 'eliza') checkAndCountAiCall(room);
      const turn = { id: room.nextTurnId++, question: text, human: null, ai: null, done: false };
      room.turns.push(turn);
      broadcast(room);
      produceAiAnswer(room, turn);
      return json(req, res, 200, { ok: true });
    }

    if (action === 'answer') {
      requireRole(room, body.token, 'responder');
      const t = pendingTurn(room);
      if (room.phase !== 'chat' || !t || t.human !== null) throw new HttpError(409, 'Det finns ingen fråga att svara på just nu.');
      t.human = cleanText(body.text, cfg.maxMessageLength, 'Svaret');
      checkTurnDone(room, t);
      return json(req, res, 200, { ok: true });
    }

    if (action === 'finish') {
      requireRole(room, body.token, 'asker');
      if (room.phase !== 'chat') throw new HttpError(409, 'Samtalet är redan slut.');
      if (doneTurns(room) < 1) throw new HttpError(409, 'Ställ minst en fråga först.');
      if (pendingTurn(room)) room.turns.pop();
      toGuess(room, 'Frågaren gick vidare till gissningen.');
      return json(req, res, 200, { ok: true });
    }

    if (action === 'guess') {
      requireRole(room, body.token, 'asker');
      if (room.phase !== 'guess') throw new HttpError(409, 'Det går inte att gissa just nu.');
      const choice = body.choice;
      if (choice !== 'A' && choice !== 'B') throw new HttpError(400, 'Välj A eller B.');
      const motivation = cleanText(body.motivation, cfg.maxMotivationLength, 'Motiveringen');
      if (motivation.length < cfg.minMotivationLength) {
        throw new HttpError(400, `Skriv en lite längre motivering (minst ${cfg.minMotivationLength} tecken).`);
      }
      const correct = choice === room.aiSlot;
      room.guess = { choice, motivation, correct };
      room.phase = 'reveal';
      const cls = classes.get(room.classCode);
      if (cls) {
        cls.stats[room.mode].guesses++;
        if (correct) cls.stats[room.mode].correct++;
        cls.motivations.unshift({ id: cls.nextMotivationId++, mode: room.mode, correct, text: motivation, hidden: false });
        if (cls.motivations.length > 200) cls.motivations.length = 200;
        cls.lastActive = now();
      }
      broadcast(room);
      return json(req, res, 200, { ok: true, correct });
    }
  }

  throw new HttpError(404, 'Okänd adress.');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders(req),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    await handleApi(req, res, url);
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof HttpError) return json(req, res, err.status, { error: err.message });
    // Oväntat fel: logga typ och var, inte meddelandetext (den kan i värsta fall innehålla indata).
    console.error('[server] Oväntat fel:', err && err.name, err && err.stack ? err.stack.split('\n').slice(1, 4).join(' | ') : '');
    return json(req, res, 500, { error: 'Något gick fel på servern.' });
  }
}

// ---------- start ----------
function start(port = cfg.port, host = cfg.host) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  // Håll SSE-anslutningar vid liv genom proxyer (t.ex. Render) med en kommentarrad var 20:e sekund.
  setInterval(() => {
    for (const room of rooms.values()) for (const c of room.clients) c.res.write(': ping\n\n');
  }, 20000).unref();

  // Städa bort gamla rum och klasser ur minnet.
  setInterval(() => {
    const t = now();
    for (const room of [...rooms.values()]) {
      const idle = t - room.lastActive;
      if ((room.phase === 'reveal' && idle > 15 * 60000) || idle > cfg.roomTtlMin * 60000) deleteRoom(room);
    }
    for (const cls of [...classes.values()]) {
      const hasRooms = [...rooms.values()].some((r) => r.classCode === cls.code);
      if (!hasRooms && t - cls.lastActive > cfg.classTtlMin * 60000) classes.delete(cls.code);
    }
  }, 60000).unref();

  server.listen(port, host, () => {
    const mode = ai.getAiMode();
    console.log(`LYSSNAR port=${server.address().port} ai=${mode}${mode === 'openai' ? ' modell=' + ai.getModel() : ''}`);
    if (mode === 'mock') console.log('[info] Testläge (mock): AI-svaren är påhittade och inga anrop görs till OpenAI.');
    if (!cfg.teacherPin) console.log('[info] TEACHER_PIN är inte satt – vem som helst med adressen kan skapa en klass.');
  });
  return server;
}

process.on('SIGTERM', () => process.exit(0));

if (require.main === module) start();

module.exports = { start };
