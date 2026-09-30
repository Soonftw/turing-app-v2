# Turingtestet v2 – klassrumsapp

En webbapp där eleverna gör ett Turingtest i par. Frågaren chattar samtidigt med två parter, A och B. Den ena är en klasskamrat (svararen) och den andra är en maskin. Frågaren ställer 3–5 frågor (ungefär 3 minuter), gissar vem som är maskinen och **måste skriva en motivering** innan svaret visas. Läraren ser anonym statistik för klassen.

Appen bygger bara på Node.js. Den har inga npm-paket att installera, ingen databas och inga konton för eleverna.

## Vad läraren kan göra (lärarvyn, adressen `/larare`)
- Skapa en klass. Du får en **klasskod** som eleverna skriver in på startsidan.
- Välja **svarsläge** och byta det mitt i lektionen (gäller för nya rum):
  - **Gymnasieelev**: en språkmodell som fått instruktionen att låtsas vara en svensk gymnasieelev.
  - **Vanlig chattbot**: en språkmodell utan persona.
  - **ELIZA**: ett enkelt regelbaserat program utan språkmodell (idén från Weizenbaums ELIZA, 1966).
  - **Blandat**: slumpas för varje nytt rum.
- Ändra antal frågor (1–10, standard 5) och tid (standard 180 sekunder, 0 = ingen tidsgräns).
- Se **anonym statistik per läge**: antal gissningar, antal rätta och andel rätt. Inga namn sparas.
- Läsa elevernas **motiveringar** anonymt. De visas först när du väljer det, och du kan dölja enskilda.

Eleverna får veta vilket läge det var först efter att de har gissat och motiverat.

## Köra lokalt (för att prova)
1. Installera Node.js version 20 eller nyare (nodejs.org). Kontrollera med `node --version`.
2. Öppna en terminal i mappen `turing-app-v2`.
3. Starta i testläge:
   ```
   node server.js --mock
   ```
4. Öppna `http://localhost:3000` (elever) och `http://localhost:3000/larare` (lärare).

I testläge (`--mock`) är AI-svaren påhittade och inget skickas någonstans. Eleverna ser en blå ruta om det. Du kan spela alla roller själv i tre webbläsarflikar: lärarvyn, en frågare och en svarare.

Automatiskt test (kräver bara Node): `node test/smoke.js`

## Driftsätta på Render (som en NY tjänst)
Den gamla v1-tjänsten (`turing-test-github-io.onrender.com`) **rörs inte**. Den står kvar som reserv om v2 inte fungerar. Du skapar en helt separat tjänst.

Förutsättning: koden i mappen `turing-app-v2` måste ligga i ett Git-förråd (till exempel ett nytt GitHub-förråd) som Render kan läsa. Lägg mappens innehåll (server.js, package.json, lib/, public/ …) i förrådets rot, eller ange mappen som *Root Directory* i steg 4. Lägg aldrig in API-nyckeln i förrådet.

1. Logga in på render.com och välj **New +** och sedan **Web Service**.
2. Koppla förrådet med v2-koden.
3. Namn: något nytt, till exempel `turingtest-v2`. Adressen blir `https://turingtest-v2.onrender.com` (eller liknande).
4. Inställningar:
   - **Language/Runtime:** Node
   - **Root Directory:** tomt (eller mappen om koden ligger i en undermapp)
   - **Build Command:** `npm install` (det finns inga paket, så det går snabbt; ett tomt fält fungerar också)
   - **Start Command:** `npm start` (samma som `node server.js`)
   - **Instance Type:** Free räcker för en klass, men gratistjänsten somnar efter en stunds inaktivitet och behöver då ungefär 30–60 sekunder för att vakna. Öppna adressen några minuter före lektionen. Betald nivå slipper väntan.
   - **Instances:** exakt 1. Allt hålls i serverns minne, så flera instanser skulle ge rum som inte hittar varandra.
5. Under **Environment** lägger du till miljövariablerna nedan (minst `OPENAI_API_KEY` och `TEACHER_PIN`).
6. Klicka **Create Web Service** och vänta tills loggen visar `LYSSNAR port=...`. Öppna sedan `/api/health` på adressen. Du ska se `"ok":true` och `"aiMode":"openai"`. Visar den `"mock"` saknas nyckeln eller läget är satt till mock.
7. Prova själv: `/larare`, skapa klass, öppna startsidan i en annan flik och kör en runda i varje läge. Kontrollera **före lektionen** att språkmodellslägena svarar.
8. Lägg adressen till v2 i elevbladet (platshållaren `[ADRESS TILL APPEN]`).

Om servern startar om eller somnar försvinner alla klasser och rum. Skapa då en ny klass. Eleverna får ett meddelande om att rummet inte finns.

## Miljövariabler
Alla är valfria utom det som behövs för riktig AI.

| Variabel | Vad den gör | Standard |
|---|---|---|
| `OPENAI_API_KEY` | Din nyckel hos OpenAI. Utan nyckel körs testläge med påhittade svar. Kan kopieras rakt från v1-tjänsten. | tom |
| `OPENAI_MODEL` | Vilken modell som används. Kontrollera själv vilka modeller som finns och vad de kostar. | `gpt-4o-mini` (ett exempel i koden, inte en rekommendation) |
| `AI_MODE` | `openai` eller `mock`. Om den inte är satt används `openai` när nyckel finns, annars `mock`. | automatiskt |
| `TEACHER_PIN` | Om satt måste läraren skriva PIN för att skapa en klass. **Sätt den på Render**, annars kan vem som helst med adressen skapa klasser och driva upp kostnaden. | tom (ingen PIN) |
| `ALLOWED_ORIGINS` | Bara om elevsidan ligger på en annan adress (till exempel GitHub Pages). Kommaseparerad lista. | tom (samma adress) |
| `AI_CALLS_PER_ROOM_PER_MINUTE` | Skydd: högst så många AI-frågor per rum och minut. | 6 |
| `AI_CALLS_PER_ROOM_TOTAL` | Skydd: högst så många AI-frågor totalt per rum. | 15 |
| `AI_CALLS_GLOBAL_PER_MINUTE` | Skydd: högst så många AI-frågor per minut för hela servern. Höj om klassen är stor. | 60 |
| `MAX_MESSAGE_LENGTH` / `MAX_MOTIVATION_LENGTH` | Högsta antal tecken i en fråga/svar och i en motivering. | 300 / 300 |
| `MAX_ROOMS` / `MAX_CLASSES` | Högsta antal rum och klasser samtidigt. | 300 / 50 |
| `ROOM_TTL_MIN` / `CLASS_TTL_MIN` | Hur länge inaktiva rum och klasser sparas i minnet (minuter). | 120 / 720 |
| `OPENAI_MAX_TOKENS`, `OPENAI_TIMEOUT_MS`, `OPENAI_TEMPERATURE`, `OPENAI_REASONING_EFFORT`, `OPENAI_BASE_URL` | Finjustering för avancerade behov. Behövs normalt inte. Vissa modeller godtar inte `OPENAI_TEMPERATURE`. | se `lib/ai.js` |
| `PORT`, `HOST` | Sätts av Render. Rör inte. | 3000 / 0.0.0.0 |

### Samma inställningar som i v1
v2 förstår v1:s namn som reserv, så att du kan kopiera över nyckel och inställningar oförändrade:

| v1 | v2 motsvarighet | Regel |
|---|---|---|
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | samma namn |
| `AI_MODEL` | `OPENAI_MODEL` | `OPENAI_MODEL` gäller om båda finns, annars `AI_MODEL` |
| `AI_PROVIDER=openai` | `AI_MODE=openai` | `AI_MODE` gäller om båda finns |
| `AI_PROVIDER=none` | `AI_MODE=mock` | testläge |
| `AI_PROVIDER=ollama` | (stöds inte) | tolkas som testläge |

## Integritet och kostnad
- **Språkmodellslägena (Gymnasieelev, Vanlig chattbot):** frågarens frågor (och tidigare frågor och AI-svar i samma samtal) skickas till OpenAI för att få ett svar. Därför visar appen en varning om att inte skriva personuppgifter. Kontrollera skolans och kommunens regler för personuppgiftsbehandling och biträdesavtal innan appen används med elever. Det ansvaret ligger hos skolan, inte i appen.
- **ELIZA-läget:** ingenting skickas till någon AI-tjänst. Programmet körs helt på servern.
- **Svararens svar** skickas aldrig till OpenAI. Bara frågarens frågor gör det.
- **Ingen loggning av innehåll.** Servern skriver inte frågor, svar eller motiveringar till loggen eller till disk. Loggen innehåller bara tekniska rader (start, antal klasser, typ av fel). Allt samtalsinnehåll ligger i serverns minne och försvinner när rummet städas bort eller servern startar om. Renders egen infrastruktur kan logga tekniska uppgifter som IP-adresser.
- **Statistiken är anonym:** antal gissningar och rätta per läge, samt motiveringar utan koppling till en person. Elever kan ändå skriva namn i en motivering, så titta igenom innan du visar dem på tavlan.
- **Kostnad:** varje fråga i ett språkmodelläge är ett betalt anrop till din OpenAI-nyckel. Skydden ovan begränsar det, men sätt gärna en månadsgräns i ditt OpenAI-konto.

## Begränsningar
- Allt ligger i minnet på en enda server. Starta inte om mitt i en lektion.
- Modellen kan avslöja sig eller svara olämpligt trots instruktionen. Läraren bör ha provat innan.
- Testet är en förenklad modell av Turingtestet: en frågare, tre minuter och en fråga i taget.

## Filer
- `server.js` – servern och API:et
- `lib/` – inställningar (`config.js`), språkmodell (`ai.js`) och ELIZA (`eliza.js`)
- `public/` – elevsidan (`index.html`, `app.js`), lärarvyn (`larare.html`, `larare.js`), gemensamt (`common.js`, `config.js`, `style.css`)
- `test/smoke.js` – automatiskt test
