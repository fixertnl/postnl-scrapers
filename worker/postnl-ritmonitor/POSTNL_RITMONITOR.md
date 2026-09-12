# PostNL Ritmonitor-worker

Zelfstandige worker (`worker/postnl-ritmonitor/`) die live bezorgvoortgang uit het PostNL OOM-PD-portaal scraapt: `Planning → Ritmonitor` toont per rit "Aantal stops" / "Stops te doen" / "Tijdstip laatste actie". Deze worker leest die grid periodiek uit en schrijft de stand naar de `ritten`-tabel in de matransport-Supabase-database.

**Deze repo (`fixertnl/postnl-scrapers`) is sinds 2026-08-25 de enige bron voor deze worker** — een vroegere kopie in de hoofd-app-repo (`fixertnl/matransport`, `worker/postnl-ritmonitor/`) is verwijderd. Reden voor de aparte repo: Akamai (PostNL's beveiliging) blokkeerde het vaste IP van de VPS waar deze worker eerder op draaide; GitHub Actions geeft elke run een ander IP uit de GitHub-pool. Zie `fixertnl/matransport`'s `CLAUDE.md` § PostNL integration voor de volledige aanleiding en het bredere app-datamodel.

**Ja — dit is ook de worker die bepaalt hoeveel uur een chauffeur gewerkt heeft** (zie [Werkuren](#werkuren--start-eind-werktijd) hieronder), maar niet als enige/primaire bron: Financiën (in de app-repo) gebruikt bij voorkeur `ritten.postnl_uren` (uit het AI-gescande dagrapport) en valt pas terug op de ritmonitor-tijden zolang er nog geen dagrapport gescand is.

## Wat het schrijft

Per rit, in de `ritten`-tabel:

| Kolom | Betekenis |
|---|---|
| `postnl_stops_totaal` | Totaal aantal stops in de rit (kolom "Aantal stops") |
| `postnl_stops_te_doen` | Nog te bezorgen stops (kolom "Stops te doen") |
| `postnl_briefbusstops` | Brievenbusstops, kolom dynamisch opgezocht via header-titel (regex `/brievenbuss/i`) — het kolomnummer verschilt per Mendix-instantie |
| `postnl_laatste_actie` | Tekst uit "Tijdstip laatste actie" (alleen tijd, geen datum) |
| `postnl_kanaal` | Kanaal-kolom |
| `postnl_chauffeur` | Chauffeursnaam zoals PostNL 'm toont (gebruikt om later te koppelen aan `users.postnl_naam`, zie `koppelChauffeurs()`) |
| `postnl_monitor_opgehaald` | Timestamp van deze scrape — ook de basis voor de "verdwenen-uit-grid"-detectie hieronder |
| `postnl_start_werktijd` / `postnl_eind_werktijd` | Zie [Werkuren](#werkuren--start-eind-werktijd) |
| `status` | `ritmonitor` is leidend zodra `stops_te_doen` bekend is: `bezig` of `gereden` (bevestigd-nul, zie hieronder) |

Elke run logt ook diagnostisch naar `ritmonitor_log` (matransport migration_v111) — per rit wat er gelezen is + welke beslissing genomen is (`actie`: `nieuw`/`gelezen`/`start-gezet`/`eind-nul`/`eind-bijgewerkt`/`verdwenen-afgerond`). Bedoeld om te achterhalen waarom een rit soms te vroeg op "gereden" springt.

## Werkuren — start/eind-werktijd

`postnl_start_werktijd` / `postnl_eind_werktijd` (matransport migration_v43) zijn dit worker's antwoord op "hoe laat is de chauffeur begonnen/gestopt":

- **Start**: eerste sync waarbij `stops_te_doen < stops_totaal` (chauffeur heeft z'n eerste stop afgeleverd) én er nog geen starttijd stond. Waarde = detectiemoment (`nu`). **Opgelet: dit is géén betrouwbare echte starttijd** — een rit die al volledig gereden is bij eerste detectie (bijv. rit #647 WVN 31-aug-2026) geeft `postnl_start_werktijd ≈ postnl_eind_werktijd` en dus een onrealistische "werktijd" van enkele minuten. De app-frontend (`matransport`) leest shift_tijden direct als echte begintijd en gebruikt `postnl_start_werktijd` alleen als fallback voor ritten zonder shift-data.
- **Eind = de laatste registratie van de dag** (besluit 2026-09-12, bepaalt de uitbetaling). `postnl_eind_werktijd` is het laatste "Tijdstip laatste actie" dat PostNL die dag voor de rit registreerde, en niets anders:
  - geen uitzondering voor "0 stops te doen";
  - geen grens na stilstand: een registratie uren later (bv. het afsluiten van de rit op het depot) telt ook;
  - nooit een tijd die we zelf afleiden, zoals het moment waarop we de rit het laatst zagen.

  Uitvoering (`nieuweEindtijd()` in `src/eindtijd.js`, getest in `test/eindtijd.test.js`): op elke poll, ongeacht status, wordt de eindtijd het maximum van de opgeslagen waarde en de gelezen registratie. Dat gebeurt vanaf de poll waarop de rit start. Vóór de start toont de kolom soms nog een tijd van de vorige dag (bv. om 07:15 al "16:36"). Die valt af omdat hij op de scrape-dag in de toekomst ligt (`nlTijdstipNaarIso()`), en omdat er vóór de start niet geteld wordt. Echte registraties lopen nooit terug: in 35.600 opeenvolgende polls (26-08 t/m 12-09) liep "laatste actie" 5 keer terug, en alle 5 keer was dat zo'n tijd van gisteren. `ritmonitor_log.actie = 'eind-bijgewerkt'` betekent dat de eindtijd echt veranderd is.

  **Geschiedenis van deze regel:**
  - Tot 2026-08-24 werd de eindtijd pas gezet bij bevestiging, en bleef hij `null` als de polling stopte.
  - Van 2026-08-24 tot 2026-09-12 volgde hij de laatst gelezen actie, maar alleen zolang `status !== 'gereden'`. Hij bevroor dus zodra "Stops te doen" twee polls op rij 0 was, terwijl de chauffeur daarna vaak nog bezig is: ophaalstops en retouren tellen niet mee, en daarna volgen terugrijden en afmelden. Bij 37% van de ritten stond de eindtijd daardoor te vroeg, gemiddeld een uur (klacht van een chauffeur, 2026-09-12).
  - Een tussenversie op 2026-09-12 had nog een grens van 90 min stilstand. Die is dezelfde dag geschrapt: ook een late registratie is een registratie.
  - Het verdwenen-pad viel tot 2026-09-12 bovendien terug op `postnl_monitor_opgehaald` als de registratie "onplausibel" leek (vóór de shift-begintijd). Die terugval is weg.

  **De afsluit-registratie — daarom leest elke run de grid herhaaldelijk (sinds 2026-09-12):** een rit blijft na de laatste levering in de Ritmonitor staan, soms uren (vastgesteld via de sessie-opname: 12-09 om ~19:10 stond 0221 er nog met laatste actie 13:50). Het afsluiten zet een laatste registratie, en kort daarna verdwijnt de rit uit de grid. Valt er tussen die registratie en het verdwijnen geen lezing, dan zien we die registratie nooit. Gemeten 26-08 t/m 11-09 met één lezing per 7 min, over ritten die tijdens de pollinguren verdwenen: 102 keer zagen we na een stille periode nog een registratie vlak vóór het verdwijnen; 343 keer stond de rit stil en was hij bij de volgende lezing weg, zonder zichtbare registratie. Daarom leest `syncMonitorDepot()` nu binnen één run de grid opnieuw tot het venster om is (`RITMONITOR_VENSTER_SEC`, standaard 300 s; een lezing kost ~15 s, dus 5 lezingen per run) met `RITMONITOR_INTERVAL_SEC` (60 s) ertussen — elke lezing navigeert opnieuw via `openRitmonitor()` (bewezen pad, incl. OAuth-herlogin), niet via een ververs-knop in de grid. De depots draaien daarvoor tegelijk (`Promise.allSettled`, elk een eigen browser); na elkaar zou de run de 7-min-cron overschrijden. De workflow heeft een `concurrency`-groep zodat een uitgelopen run niet gelijktijdig met de volgende dezelfde ritten beschrijft.
  - **Noodrem:** repository-variabele `RITMONITOR_VENSTER_SEC` op `0` (Settings → Secrets and variables → Actions → Variables) → één lezing per run, zonder code-wijziging. Gebruik dit als Akamai het verkeer gaat blokkeren (symptoom: `worker_run_log.depots_mislukt` met login-/time-outfouten bij beide depots).
  - `ritmonitor_log` krijgt alleen een rij als er iets veranderde t.o.v. de vorige lezing (stops, registratie, status, start/eind) — identieke herhalingen worden niet gelogd, anders groeide de tabel zes keer zo snel.
  - Wat na deze wijziging nog gemist kan worden: een registratie die binnen de 60 s tussen twee lezingen wordt gezet én waarna de rit vóór de volgende lezing al weg is, plus alles buiten de pollinguren (07:00–23:00) — dan blijft de laatst gezíene registratie staan.

  **Front-end-conventie** (`eindtijdOnbevestigd()` in matransport's `RitDetail.jsx`/`Financien/index.jsx`): zolang `status !== 'gereden'` is de eindtijd voorlopig. Een `!` achter de eindtijd verschijnt alleen als de rit dan ook nog van een vorige dag is. Baseer je nooit op "is `postnl_eind_werktijd` gevuld?" om te bepalen of een rit klaar is — gebruik `status === 'gereden'`.
  **Historie herberekend op 2026-09-12** (26-08 t/m 12-09, zonder 07-09) met `scripts/herbereken-eindtijden.js`. Dat script speelt elke rit na uit `ritmonitor_log`. Ter controle speelt het ook de oude regels na, en die reproduceerden 549 van de 552 toen opgeslagen eindtijden exact. De gegenereerde SQL en de terugdraai-SQL staan in `fixertnl/matransport`, `supabase/backfills/2026-09-12_ritmonitor_eindtijd/` (bewust niet hier: deze repo is publiek). Verander je de regel opnieuw, dan kun je hetzelfde script weer gebruiken.

  **07-09 is bewust niet herberekend.** Die dag is de ritmonitor tussen 10:44 en 19:35 helemaal niet gestart (geen rij in `worker_run_log`; het staleness-alarm vuurde wel elk uur). Toen hij weer draaide, waren alle ritten uit de grid en zijn ze afgerond met een ochtendtijd, met tientallen stops nog open. De echte eindtijden zijn niet uit de data terug te halen.

- **`status = 'gereden'`** wordt door een van deze twee paden gezet. Die bepalen alleen de **status**, niet de eindtijd:
  1. **Bevestigd-nul**: `stops_te_doen` is twee polls op rij `0` (`stopsTeDoenBevestigdNul` in `opslaanMonitorInSupabase()`). Één keer 0 wordt niet vertrouwd — een vers aangemaakte rij toont soms eenmalig foutief 0 vóór de echte waarde laadt.
  2. **Verdwenen uit de grid**: PostNL haalt een rit uit Ritmonitor als hij afgesloten is, vaak zonder ooit "0 te doen" te tonen (onbezorgbare stops blijven "te doen"). Een rit die ≥ 20 min (`AFWEZIG_DREMPEL_MIN`, ≈ 3 gemiste polls bij de huidige cron) niet meer in de grid stond en onderweg was (voortgang gemaakt), gaat op `gereden`. De eindtijd staat dan al door de continue update. Alleen als die er om wat voor reden niet is, wordt hij aangevuld uit de laatst gelezen registratie, nooit uit een ander tijdstip.
  - Alleen actief als de scrape zelf rijen opleverde — een lege lijst is waarschijnlijk een mislukte/half-geladen grid, dan wordt er niets afgerond (een half-geladen grid liet ooit bezige ritten eenmalig verdwijnen → vals afgerond, vandaar de dubbele-miss-eis).

**Gebruikt door (in `fixertnl/matransport`):** `src/pages/Ritten/RitDetail.jsx`/`index.jsx` (live werktijd-timer + weergave via `postnl_eind_werktijd`; begintijd komt uit `shift_tijden` direct), `src/pages/Financien/index.jsx` (`getRitUren()`, prioriteit: dagrapport-scan → shift_tijden + `postnl_eind_werktijd` → null; `postnl_start_werktijd` is bewust geen fallback meer) en `src/lib/rittenMaandExport.js` (overwerkberekening). `postnl_uren` (AI-gescand dagrapport) heeft altijd voorrang boven de ritmonitor-tijden.

### Reserve- en ad-ritten — afwijkende `shift`/`postnl_start_werktijd`-behandeling (issue #107)

`shift_tijden` (matransport) kent alleen shift 1-6 (uit de wekelijkse shifttijden-mail). Twee categorieën ritten vallen daarbuiten en kregen tot issue #107 een verkeerde `shift`/begintijd:

- **Reserve-ritten** — `isReserveRitnummer(ritnummer)`: een 4-cijferig ritnummer, of het eerste cijfer van het ritnummer is `9`. Reservechauffeurs hebben geen vaste shift, dus geen `shift_tijden`-match. **Begintijd**: bij de eerste detectie (`stopsTeDoen < stopsTotaal` en nog geen `postnl_start_werktijd`) wordt niet het detectiemoment (`nu`) gebruikt, maar de op dat moment gelezen "Tijdstip laatste actie" zelf (via `nlTijdstipNaarIso()`), met terugval op `nu` als die tekst onparseerbaar is. Reden: het detectiemoment kan een willekeurige pollingtijd na de echte eerste bezorging zijn; "laatste actie" bij eerste detectie ligt er dichter tegenaan. (Het "verdwenen-uit-grid"-pad had tot 2026-09-12 een eigen shift-begintijd-lookup voor een plausibiliteitscheck, met dezelfde uitzondering voor reserve-ritten. Die check is weg, zie § Werkuren.)
- **Ad-ritten (avond)** — `isAdKanaal(kanaal)`: kanaal-code `AD`. Krijgen `shift: null` (geen shiftlabel — er is toch geen shift_tijden-data voor avondritten) en een **vaste begintijd van 17:00** (`shiftTijdNaarIso(datum, '17:00')`) bij eerste detectie, in plaats van het detectiemoment.

**`shift: null` wordt sinds de vervolgfix (2026-09-03) ook zelfhelend op élke update-poll gezet** (`...(isAdKanaal(rit.kanaal) && { shift: null })` in `velden`, niet alleen bij `teInserten`) — `shift` werd daarvoor alléén bij het aanmaken van een rit-rij gezet, dus een bestaande ad-rit-rij van vóór deze fix hield voor altijd zijn oude/foute shiftcijfer, ook nadat nieuwe ad-rit-rijen al correct `shift: null` kregen. Dekt nog steeds niet een ad-rit die al `gereden` is (die wordt sowieso nooit meer gepolld) — daarvoor is een eenmalige backfill gedraaid voor bestaande rijen, zie de frontend-noot hieronder voor de structurele oplossing.

**Frontend-kant (`fixertnl/matransport`):** `src/lib/ritSoort.js`'s `isReserveRit(rit)` (zelfde regel, `String(ritnummer).length === 4 || String(shift) === '9'`) én `isAdRit(rit)` (`postnl_kanaal === 'AD'`) sluiten beide categorieën uit van elke `shift_tijden`-lookup/shift-badge in `RitDetail.jsx`, `Ritten/index.jsx`, `Financien/index.jsx` en `Dashboard/index.jsx`. **Belangrijk:** vertrouw hiervoor nooit op de aanname dat `rit.shift` voor een ad-rit al `null` is — zoals hierboven beschreven blijft dat voor bestaande/al-`gereden` rijen soms het oude cijfer, dus de frontend moet `isAdRit(rit)` altijd expliciet checken naast (of in plaats van) een kale `rit.shift`-check, ook al "zou" het veld leeg moeten zijn. Dit was precies de vervolgbug die na de eerste #107-fix nog zichtbaar bleef (rit #305 toonde nog "Shift 3 · 08:20" ondanks kanaal AD).

## Trigger-pad (GitHub Actions, niet VPS)

```
pg_cron 'ritmonitor-7min' (elke 7 min, 07:00–23:00 Amsterdam, Supabase-DB van fixertnl/matransport)
  → public.trigger_ritmonitor()  (loopt over élke klant met actieve postnl-credentials)
    → net.http_post rechtstreeks naar de GitHub API
      → POST /repos/fixertnl/postnl-scrapers/actions/workflows/postnl-ritmonitor.yml/dispatches
        (Vault-secret 'postnl_scrapers_token', GitHub secret-auth binnen deze repo)
      → workflow_dispatch → deze repo's Actions-run → node src/index.js --once
```

⚠️ **Check de live functiedefinitie van `trigger_ritmonitor()` in Supabase (`select pg_get_functiondef(oid) from pg_proc where proname = 'trigger_ritmonitor'`) als je hieraan twijfelt** — deze functie is ooit rechtstreeks in de database aangepast (dit trigger-pad), zonder een migratiebestand in `matransport` te raken. Vertrouw dus niet blind op wat matransport's migratiebestanden beweren.

- **Timeout 10 minuten** (`timeout-minutes` in de workflow) — een run duurt sinds het herhaald lezen (2026-09-12) ~6 min (`RITMONITOR_VENSTER_SEC` 300 s + opstarten en inloggen; de eerste run met 330 s duurde 6 m 37 s, te krap), daarvóór 1-2 min.
- **`concurrency: postnl-ritmonitor`, `cancel-in-progress: false`** (sinds 2026-09-12): hooguit één run tegelijk, een volgende trigger wacht. Voorheen was dat niet nodig (runs van 1-2 min overlapten nooit); nu een run bijna het hele 7-min-interval vult, zou een trage start anders gelijktijdig met de volgende run dezelfde ritten beschrijven.
- **Nooit `on: schedule` gebruiken** — dat vuurt minuten tot uren te laat. De workflow triggert uitsluitend op `workflow_dispatch`.
- **Geen sessie-hergebruik tussen runs** — elke run krijgt een vers container-filesystem, dus altijd een verse login (in tegenstelling tot de vroegere VPS-opzet, die een `storageState`-sessie hergebruikte). Zie de tijdzone-gotcha hieronder voor waarom dit relevant is.

**Handmatig testen:**
```bash
cd worker/postnl-ritmonitor
npm install && cp .env.example .env   # KLANT_ID + credentials nodig, zie hieronder
npm run playwright:install
npm run sync:once                      # headless
POSTNL_HEADLESS=false npm run sync:once  # zichtbare browser
```
Of via **Actions → PostNL Ritmonitor → Run workflow** in de GitHub UI, of `gh workflow run postnl-ritmonitor.yml`.

## Credentials

Per klant in Supabase-tabel `klant_credentials` (versleuteld), opgehaald via `worker/credentials-shared/src/index.js`'s `getDepots(supabase, klantId, 'postnl')`. `KLANT_ID`/`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`CREDENTIALS_ENCRYPTION_KEY` komen uit GitHub Secrets (zie root-`README.md`). Zie `fixertnl/matransport`'s `CLAUDE.md` § Credentials per klant voor het volledige per-klant-verhaal.

## Scrape-mechaniek (breekbaar — Mendix-portaal)

Grotendeels identiek aan de boilerplate in `worker/postnl-dagplanning/` (bewust — zie header-comment in `src/index.js`):

- **`serviceWorkers: 'block'`** in de Playwright-context — de Mendix service-worker veroorzaakt anders herlaad-/chrome-error-loops vlak na de OAuth-redirect.
- **"Tijdstip laatste actie" wisselt van tijdzone — UTC of NL-lokaal, niet voorspelbaar welke** (ontdekt 2026-08-24, tweede keer geraakt 2026-08-25, ondanks dat elke run hier een vers container-filesystem krijgt — dus **geen** sessie-hergebruik als verklaring, in tegenstelling tot wat op de vroegere VPS werd vermoed). Op 24 aug consistent UTC (gemeten door een live scrape naast een live screenshot te leggen: alle vergeleken ritten precies 2:00 verschil). Minder dan 24 uur later, zonder enige codewijziging, bleek de tekst NL-lokaal — een rit kreeg daardoor een `postnl_eind_werktijd` die **in de toekomst** lag (rit 905, 25 aug: "21:47"-tekst → opgeslagen als 21:47 UTC = 23:47 NL, terwijl het scrape-moment zelf pas 22:16 NL was).
  - **Oorzaak niet hard vastgesteld** — mogelijk iets serverzijdig bij Mendix (load-balancer/regio-afhankelijk?), niet gerelateerd aan sessie-caching zoals eerst gedacht.
  - **Echte oorzaak en fix: `timezoneId` op de browser-context** (`openDepotSessie()`, sinds de eerste commit van deze repo op 25-08). Mendix rendert de tijd client-side in de tijdzone van de browser. Zonder die instelling was dat de systeemtijdzone van de runner (UTC). Sindsdien is de tekst altijd NL-lokaal: in 20.500 polls tussen 26-08 en 12-09 lag de tekst nooit ná het scrape-moment, en 95% lag 0–30 min ervóór.
  - **De tussentijdse heuristiek is op 2026-09-12 verwijderd.** Tot dan rekende `nlTijdstipNaarIso()` beide interpretaties uit en koos de meest recente die niet in de toekomst lag. Met NL-tekst ging dat mis zodra een "laatste actie" bij het uitlezen meer dan 2 uur oud was. De UTC-lezing lag dan ook niet meer in de toekomst en won, waardoor de eindtijd **precies 2 uur te laat** uitkwam (bv. 29-08 rit 715: 17:50 opgeslagen als 19:50; 16 ritten tussen 26-08 en 12-09). De functie staat nu in `src/eindtijd.js` en leest de tekst altijd in de tijdzone van de browser-context (`CONFIG.timezone`). Een tijd die meer dan 5 min na het scrape-moment ligt, wordt verworpen.
  - **Verander je ooit `timezoneId`, pas dan ook de tijdzone aan waarmee `nlTijdstipNaarIso()` leest.** In `index.js` geven ze allebei `CONFIG.timezone` door; houd dat zo.
- **Login-detectie**: wacht op `!hostname.includes('loginpostnl')`, **niet** `waitForURL('**pnl-oompd**')` — de login-URL bevat die string zelf in een redirect-param → vals-positief.
- **`waitForPlanning()`**: Mendix start de OAuth-redirect soms pas ná `page.goto()` (tijdens het laden van de app), dus een directe URL-check na `goto` mist 'm. Oplossing: pollen (1x/seconde, max 90s) tot het Planning-menu zichtbaar is óf OAuth gedetecteerd wordt (dan herlogin, max 3x, en doorgaan).
- **Riteigenaar-grid (M&A Transport) staat al geselecteerd** bij het laden van Ritmonitor — daar niet op klikken, anders deselecteer je 'm.
- **Overview-grid identificatie**: de pagina bevat meerdere `.mx-grid-content table`-elementen; de juiste is die met `th[title="Stops te doen"]` (onderscheidt 'm van de Riteigenaar-grid links).
- **Brievenbusstops-kolom**: dynamisch via header-titel opgezocht (regex `/brievenbuss/i`) i.p.v. een vast kolomnummer — dat kolomnummer verschilt per Mendix-instantie van de Overview-shift-grid.
- **Ritnaam-parsing**: alleen rijen met een ritnaam die begint met 3-4 cijfers (`/^\d{3,4}/`) én een parseerbaar `stopsTotaal` worden meegenomen; `normaliseerRitnummer()` strip voorloopnullen zodat het matcht met `ritten.ritnummer`.

## Server-modus (bestaat, ongebruikt)

Náást `--once` (wat GitHub Actions gebruikt) heeft `src/index.js` ook een daemon-modus (`npm start`): luistert op `MONITOR_PORT` (default 3002) met `POST /sync-monitor` (auth `X-Worker-Secret`) en `GET /health`, plus een optionele eigen `node-cron`-schedule via `MONITOR_CRON`. Restant uit een eerdere (VPS-)periode van dit project. Blijft in de code staan als alternatief pad, maar wordt niet gebruikt.

## Chauffeur-koppeling

`koppelChauffeurs()` draait na elke succesvolle run (ook bij gedeeltelijk mislukte depots): matcht `ritten.postnl_chauffeur` (tekst zoals PostNL 'm toont) tegen `users.postnl_naam` binnen dezelfde klant, en zet `chauffeur_id` daarop — **niet alleen waar dat nog leeg was**: een rit mag nooit op een andere chauffeur blijven staan dan wie PostNL's eigen data rapporteert, want dat veld bepaalt wie voor de stops betaald krijgt. `@Home`/freelance-ritten (geen `postnl_chauffeur`-waarde) blijven hierdoor automatisch buiten bereik — de match-voorwaarde zelf sluit `null` al uit. Per-klant `users`-lijst wordt één keer opgehaald, dan per gebruiker een gerichte update — geen bulk-matching op naam-gelijkenis.

## Per-depot foutisolatie

`syncRitmonitor()` draait de depots tegelijk (`Promise.allSettled`, sinds 2026-09-12 — daarvóór na elkaar) en isoleert fouten: één depot dat faalt (trage grid, sessie-redirect) stopt niet de hele run — de overige depots draaien gewoon door. Binnen een depot geldt hetzelfde per lezing: faalt een lezing nadat er al één slaagde, dan stopt alleen het herhalen en telt wat al opgeslagen is. Alleen als **alle** depots falen gooit de run alsnog een fout. Chauffeur-koppeling draait ook bij gedeeltelijk succes.

## Run-monitoring (`worker_run_log`)

`syncRitmonitor()` schrijft naast de console.log-regels ook een gestructureerde rij naar de Supabase-tabel `public.worker_run_log` (matransport migration_v150, generiek per worker, `worker_naam`-kolom):
- **INSERT bij start** (`startRunLog()`) — `status: 'gestart'`, plus `run_url` (matransport migration_v157): `githubRunUrl()` bouwt de directe link naar de Actions-run op uit GitHub's eigen `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID` env-vars (automatisch gezet, geen configuratie nodig) — `null` buiten GitHub Actions. Een gecrashte run die de UPDATE nooit haalt, blijft dus zichtbaar als "gestart maar nooit afgerond", én je kan direct doorklikken naar de logs zonder handmatig `gh run list` te doorzoeken.
- **UPDATE bij einde** (`eindeRunLog()`) — `status: 'ok'/'deels_mislukt'/'mislukt'`, `depots_ok`, `depots_mislukt` (jsonb-array van `{depot, fout}`-objecten), `rijen_gelezen`.
- Beide functies zijn **best-effort** (eigen try/catch) — een logging-probleem mag de eigenlijke sync nooit blokkeren.

**Staleness-alert**: `public.check_worker_staleness()` (pg_cron in matransport's Supabase-project, elke 15 min, 06:15–22:55 NL-tijd) checkt of de laatste succesvolle run niet ouder is dan 20 minuten en pusht zo nodig naar de admins. Werkt automatisch voor deze GitHub-Actions-runs, want ze schrijven naar dezelfde database met dezelfde `worker_naam` — geen aparte configuratie nodig.

## Sessie-video (`worker-sessies` bucket)

Elke depot-sessie neemt een Playwright-video op (`recordVideo` op de browser-context, 1280×720) — zodat je kan meekijken in de browser zonder zelf `POSTNL_HEADLESS=false` te hoeven draaien. Alleen voor deze worker gebouwd (niet voor `postnl-dagplanning`).

- **`bewaarSessieVideo(video, depotNaam)`** draait na `context.close()`/`browser.close()` (Playwright rondt het video-bestand pas dán af — ervoor ophalen geeft een onvolledig bestand) en uploadt naar de private Supabase Storage-bucket `worker-sessies` (matransport migration_v156).
- **Pad-conventie: overwrite-latest**, geen timestamp: `{klant_id}/postnl-ritmonitor/{depot-slug}-latest.webm`. Elke run overschrijft de vorige video van dat depot — bewuste keuze om opslag te begrenzen tot één video per depot i.p.v. een onbeperkt groeiend archief (geen aparte opschoon-cron nodig). Je ziet dus altijd alleen de laatste sessie, niet de geschiedenis.
- **Best-effort, net als de run-log**: een mislukte video-upload (bv. netwerkfout) logt een warning en laat de sync gewoon doorgaan — nooit de sync zelf laten falen op een video-probleem.
- `syncMonitorDepot()` geeft nu `{ rijen, videoPath }` terug (bij een fout: gooit alsnog, maar met `.videoPath` op het error-object, zodat een video van een mislukte poging ook bewaard blijft). `syncRitmonitor()` verzamelt deze in `videoPaths` en schrijft ze als `video_paths` (jsonb-array van `{depot, storage_path}`) naar `worker_run_log` — zowel bij succes/gedeeltelijk succes als bij "alle depots faalden".
- **Bekijken**: signed URL ophalen via `storageUrls.js`-patroon (RLS: alleen admins, klant-gescoped via `(storage.foldername(name))[1] = my_klant_id()::text`) — er is nog geen UI-knop voor gebouwd, dit is puur de opslagkant. Handmatig ophalen kan via `supabase.storage.from('worker-sessies').createSignedUrl(path, ...)`.
