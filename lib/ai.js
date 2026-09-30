'use strict';
// Språkmodellsdelen: OpenAI Chat Completions via global fetch, eller påhittade svar i mock-läge.
// Inget chattinnehåll loggas här.

// ---------------------------------------------------------------------------
// STANDARDMODELL – ändra här, eller (bättre) sätt miljövariabeln OPENAI_MODEL.
// Värdet är ett exempel. Kontrollera själv vilka modeller som finns och vad de
// kostar hos OpenAI innan lektionen. Koden påstår inte att modellen är aktuell.
const DEFAULT_MODEL = 'gpt-4o-mini';
// ---------------------------------------------------------------------------

const PERSONAS = {
  gymnasieelev: [
    'Du deltar i ett Turingtest i en svensk gymnasieklass. En elev chattar med dig och med en riktig människa samtidigt och ska gissa vem som är AI.',
    'Din uppgift: låtsas vara en människa, en 17-årig gymnasieelev i Sverige.',
    'Svara på svenska, vardagligt och kort: oftast en eller två meningar, sällan mer än 25 ord.',
    'Skriv som i en chatt: ofta små bokstäver, ibland ett litet stavfel eller ett utelämnat skiljetecken. Inga listor, inga rubriker, ingen överdriven artighet.',
    'Du behöver inte kunna allt. Det är okej att säga "vet inte" eller att gissa.',
    'Avslöja aldrig att du är en AI eller en språkmodell, inte ens om någon frågar rakt ut. Svara då som en människa skulle.',
    'Hitta inte på riktiga namn, adresser, telefonnummer eller andra personuppgifter. Säg hellre att du inte vill berätta.',
    'Skriv inget kränkande, sexuellt eller farligt. Om frågan är olämplig, byt ämne som en tonåring skulle.',
  ].join('\n'),
  chattbot: [
    'Du är en hjälpsam AI-assistent. Svara på svenska.',
    'Håll svaret kort, högst tre meningar, eftersom det visas i en chatt.',
    'Skriv inget kränkande, sexuellt eller farligt.',
  ].join('\n'),
};

const MOCK_REPLIES = {
  gymnasieelev: [
    'haha typ, vet inte riktigt',
    'asså jag tror det iaf',
    'nej inte direkt lol',
    'hmm svår fråga, kanske',
    'ja fast det beror på',
    'orkar inte tänka så mycket nu haha',
  ],
  chattbot: [
    'Det är en intressant fråga! Kort sagt beror det på sammanhanget.',
    'Jag förstår vad du menar. Ett kort svar är: ja, i de flesta fall.',
    'Bra fråga. Det finns flera sätt att se på det, men det vanligaste är att det stämmer.',
    'Tack för frågan! Jag svarar gärna: det viktigaste är att tänka kritiskt.',
    'Det kan jag förklara kort. Svaret är nej, men det finns undantag.',
  ],
};

function getAiMode() {
  const m = String(process.env.AI_MODE || '').trim().toLowerCase();
  if (m === 'mock') return 'mock';
  if (m === 'openai') return 'openai';
  // Reserv för v1:s miljövariabler: AI_PROVIDER=openai -> riktigt läge, none/ollama -> testläge.
  // (Ollama stöds inte i v2.) AI_MODE har alltid företräde.
  const p = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (p === 'openai') return 'openai';
  if (p === 'none' || p === 'ollama') return 'mock';
  return process.env.OPENAI_API_KEY ? 'openai' : 'mock';
}

function getModel() {
  // OPENAI_MODEL har företräde; AI_MODEL är v1:s namn och fungerar som reserv.
  return process.env.OPENAI_MODEL || process.env.AI_MODEL || DEFAULT_MODEL;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mockReply(mode, history) {
  const delay = parseInt(process.env.MOCK_DELAY_MS || '600', 10);
  if (delay > 0) await sleep(delay);
  const list = MOCK_REPLIES[mode] || MOCK_REPLIES.chattbot;
  const turnNo = history.filter((m) => m.role === 'user').length;
  return list[(turnNo - 1 + list.length) % list.length];
}

/**
 * Ger ett svar från språkmodellen.
 * @param {'gymnasieelev'|'chattbot'} mode
 * @param {{role:'user'|'assistant', content:string}[]} history hela samtalet, sista posten är den nya frågan
 */
async function generate(mode, history) {
  if (!PERSONAS[mode]) throw new Error('Okänt AI-läge');
  if (getAiMode() === 'mock') return mockReply(mode, history);

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error('OPENAI_API_KEY saknas');
    err.status = 'ingen-nyckel';
    throw err;
  }
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const body = {
    model: getModel(),
    messages: [{ role: 'system', content: PERSONAS[mode] }, ...history],
    max_completion_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '300', 10),
  };
  if (process.env.OPENAI_TEMPERATURE) body.temperature = Number(process.env.OPENAI_TEMPERATURE);
  if (process.env.OPENAI_REASONING_EFFORT) body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(parseInt(process.env.OPENAI_TIMEOUT_MS || '20000', 10)),
  });
  if (!res.ok) {
    const err = new Error(`OpenAI svarade med status ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) {
    const err = new Error('Tomt svar från modellen');
    err.status = 'tomt-svar';
    throw err;
  }
  return text.trim();
}

module.exports = { generate, getAiMode, getModel, DEFAULT_MODEL, PERSONAS };
