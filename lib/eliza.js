'use strict';
// En enkel svensk ELIZA-variant. Ingen språkmodell och inget nätverk:
// programmet letar efter nyckelord i en fast ordning, plockar ut en del av
// meningen, byter pronomen (jag <-> du, min <-> din ...) och sätter in den i en mall.
// Idén kommer från Joseph Weizenbaums program ELIZA (1966).

// Ordgränser som fungerar med å, ä och ö (JavaScripts \b gör det inte).
const LETTER = '\\p{L}\\p{N}';
const START = `(?<![${LETTER}])`;
const END = `(?![${LETTER}])`;
function rx(src) {
  return new RegExp(src.replace(/«/g, START).replace(/»/g, END), 'u');
}

const REFLECTIONS = {
  jag: 'du', mig: 'dig', mej: 'dig', min: 'din', mitt: 'ditt', mina: 'dina',
  du: 'jag', dig: 'mig', dej: 'mig', din: 'min', ditt: 'mitt', dina: 'mina',
};

function reflect(fragment) {
  return fragment
    .split(/(\s+)/)
    .map((tok) => (Object.prototype.hasOwnProperty.call(REFLECTIONS, tok) ? REFLECTIONS[tok] : tok))
    .join('');
}

// Ordningen är prioriteringen: den första regel som matchar används.
const RULES = [
  { p: '^(?:hej|hejsan|hallå|tjena|tja|tjabba|god ?morgon|god ?dag)»[\\s!.,]*$', r: ['Hej! Vad vill du prata om i dag?', 'Hej. Hur mår du just nu?'] },
  { p: '«(?:är|e) du (?:en |ett )?(?:ai|robot|bot|dator|maskin|människa|chatgpt|chattbot|program)»', r: ['Varför undrar du om jag är en maskin?', 'Skulle det spela någon roll för dig om jag var en dator?', 'Vad tror du själv?'] },
  { p: '«(?:ai|robot|robotar|dator|datorer|maskin|maskiner|chatgpt|chattbot|program)»', r: ['Oroar datorer dig?', 'Varför pratar du om maskiner?', 'Vad tror du att maskiner har med saken att göra?'] },
  { p: '«jag känner mig (.+)', r: ['Varför känner du dig $1?', 'Hur länge har du känt dig $1?', 'Känner du dig ofta $1?'] },
  { p: '«jag mår (.+)', r: ['Varför tror du att du mår $1?', 'Hur länge har du mått $1?'] },
  { p: '«jag (?:tycker om|gillar|älskar) (.+)', r: ['Vad är det med $1 som du gillar?', 'Hur länge har du gillat $1?', 'Varför betyder $1 så mycket för dig?'] },
  { p: '«jag (?:hatar|ogillar|avskyr|tycker illa om) (.+)', r: ['Vad är det med $1 som stör dig?', 'Varför känner du så starkt för $1?'] },
  { p: '«jag tycker(?: att)? (.+)', r: ['Varför tycker du att $1?', 'Är du säker på att $1?', 'Vad får dig att tycka det?'] },
  { p: '«jag tror(?: att)? (.+)', r: ['Tror du verkligen att $1?', 'Men du är inte helt säker på att $1?', 'Varför tror du det?'] },
  { p: '«jag vill (.+)', r: ['Varför vill du $1?', 'Vad skulle det betyda för dig om du kunde $1?', 'Vad hindrar dig?'] },
  { p: '«jag (?:kan inte|kan ej) (.+)', r: ['Hur vet du att du inte kan $1?', 'Har du försökt?', 'Kanske skulle du kunna $1 om du försökte.'] },
  { p: '«jag minns (.+)', r: ['Tänker du ofta på $1?', 'Vad mer minns du?', 'Varför kommer du att tänka på $1 just nu?'] },
  { p: '«jag (?:är|e) (.+)', r: ['Varför är du $1?', 'Hur länge har du varit $1?', 'Tycker du om att vara $1?', 'Tror du att det är vanligt att vara $1?'] },
  { p: '«du (?:är|e) (.+)', r: ['Varför tror du att jag är $1?', 'Gillar du att tänka att jag är $1?', 'Kanske är det du som är $1?'] },
  { p: '«(?:mamma|pappa|mor|far|morsan|farsan|förälder|föräldrar|syster|bror|syskon|familj|familjen)»', r: ['Berätta mer om din familj.', 'Hur är det hemma med familjen?', 'Vem i din familj står dig närmast?'] },
  { p: '«(?:skola|skolan|lektion|lektionen|prov|provet|läxa|läxor|läxan|lärare|läraren|betyg|plugga|pluggar)»', r: ['Hur känns det med skolan just nu?', 'Vad tänker du om skolan?', 'Påverkar skolan hur du mår?'] },
  { p: '«(?:dröm|drömmer|drömde|drömmar)»', r: ['Vad tror du att drömmen betyder?', 'Drömmer du ofta?'] },
  { p: '«(?:förlåt|ursäkta|sorry)»', r: ['Du behöver inte be om ursäkt.', 'Varför känner du att du måste be om ursäkt?'] },
  { p: '«(?:eftersom|för att)»', r: ['Är det den verkliga anledningen?', 'Finns det andra förklaringar?'] },
  { p: '«(?:alltid|aldrig)»', r: ['Kan du ge ett konkret exempel?', 'Är det verkligen så varje gång?'] },
  { p: '«(?:alla|ingen|inga|ingenting)»', r: ['Tänker du på någon särskild?', 'Verkligen? Utan undantag?'] },
  { p: '^(?:ja|jo|japp|jaa|absolut)»', r: ['Du verkar säker på det.', 'Jag förstår. Kan du utveckla?'] },
  { p: '^(?:nej|nä|nää|nope)»', r: ['Varför inte?', 'Säger du nej bara för att vara negativ?'] },
  { p: '\\?\\s*$', r: ['Varför frågar du det?', 'Vad tror du själv?', 'Är det frågan som är viktig för dig?', 'Vad skulle du helst vilja att jag svarade?'] },
].map((rule) => ({ re: rx(rule.p), replies: rule.r }));

const DEFAULTS = ['Berätta mer.', 'Jag förstår. Fortsätt.', 'Hur känns det för dig?', 'Varför säger du det?', 'Intressant. Kan du utveckla?', 'Vad betyder det för dig?'];
const MEMORY_RE = rx('«(min|mitt|mina) (\\p{L}+)»');

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function createEliza() {
  const counters = new Map();
  const memory = [];
  let defaultCount = 0;

  function next(key, list) {
    const n = counters.get(key) || 0;
    counters.set(key, n + 1);
    return list[n % list.length];
  }

  function reply(input) {
    const text = String(input || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!text) return 'Säg något, jag lyssnar.';

    const mem = text.match(MEMORY_RE);
    if (mem) memory.push(reflect(`${mem[1]} ${mem[2]}`));

    for (let i = 0; i < RULES.length; i++) {
      const m = text.match(RULES[i].re);
      if (!m) continue;
      let fragment = '';
      if (m[1] !== undefined) {
        fragment = m[1].split(/[.!?,;:]/)[0].trim();
        if (!fragment) continue;
        fragment = reflect(fragment);
      }
      return capitalize(next(i, RULES[i].replies).replace('$1', fragment));
    }

    // Ingen regel passade. Använd minnet om det finns något sparat från tidigare.
    if (memory.length > 0 && !mem) {
      return `Tidigare nämnde du ${memory.shift()}. Berätta mer om det.`;
    }
    return DEFAULTS[defaultCount++ % DEFAULTS.length];
  }

  return { reply };
}

module.exports = { createEliza, reflect };
