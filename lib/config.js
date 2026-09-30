'use strict';
// Alla inställningar läses från miljövariabler. Se README.md för en förklaring av varje variabel.

function int(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = parseInt(raw, 10);
  if (Number.isNaN(v)) return def;
  return Math.min(max, Math.max(min, v));
}

const portRaw = process.env.PORT;

module.exports = {
  port: portRaw !== undefined && portRaw !== '' ? Number(portRaw) : 3000,
  host: process.env.HOST || '0.0.0.0',

  // Skyddsgränser
  maxMessageLength: int('MAX_MESSAGE_LENGTH', 300, 20, 2000),
  maxMotivationLength: int('MAX_MOTIVATION_LENGTH', 300, 20, 2000),
  minMotivationLength: 10,
  aiPerRoomPerMinute: int('AI_CALLS_PER_ROOM_PER_MINUTE', 6, 1, 100),
  aiPerRoomTotal: int('AI_CALLS_PER_ROOM_TOTAL', 15, 1, 500),
  aiGlobalPerMinute: int('AI_CALLS_GLOBAL_PER_MINUTE', 60, 1, 10000),
  maxRooms: int('MAX_ROOMS', 300, 1, 10000),
  maxClasses: int('MAX_CLASSES', 50, 1, 1000),
  roomTtlMin: int('ROOM_TTL_MIN', 120, 5, 1440),
  classTtlMin: int('CLASS_TTL_MIN', 720, 30, 10080),

  // Lärar-PIN: om satt krävs den för att skapa en klass (rekommenderas på Render).
  teacherPin: process.env.TEACHER_PIN || '',

  // CORS: kommaseparerad lista, t.ex. "https://johannes.github.io". Tomt = bara samma adress.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
};
