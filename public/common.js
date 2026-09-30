// Gemensamt för elevsidan och lärarsidan: serveranrop, "servern vaknar"-ruta och små DOM-hjälpare.
'use strict';

const SERVER = String(window.TURING_SERVER_URL || '').replace(/\/$/, '');
const WAKE_DELAY_MS = 3000;

function $(id) {
  return document.getElementById(id);
}
function show(el, on = true) {
  if (typeof el === 'string') el = $(el);
  if (el) el.hidden = !on;
}
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

let wakeCount = 0;
function wakeStart() {
  wakeCount++;
  return setTimeout(() => show('banner-wake', true), WAKE_DELAY_MS);
}
function wakeStop(timer) {
  clearTimeout(timer);
  wakeCount = Math.max(0, wakeCount - 1);
  if (wakeCount === 0) show('banner-wake', false);
}

async function api(path, body) {
  const timer = wakeStart();
  try {
    let res;
    try {
      res = await fetch(SERVER + path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' });
    } catch {
      throw new Error('Når inte servern. Kontrollera nätverket och försök igen.');
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* tomt svar */
    }
    if (!res.ok) {
      const err = new Error(data.error || `Fel från servern (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    wakeStop(timer);
  }
}

// Väcker servern (t.ex. efter viloläge på Render) och försöker igen i upp till ca 90 s.
async function wakeServer() {
  const timer = wakeStart();
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const res = await fetch(SERVER + '/api/health', { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch {
        /* försök igen */
      }
      show('banner-wake', true);
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('Servern svarar inte. Ladda om sidan om en stund, eller säg till läraren.');
  } finally {
    wakeStop(timer);
  }
}
