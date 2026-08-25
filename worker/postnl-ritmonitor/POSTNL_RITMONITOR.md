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

- **Start**: eerste sync waarbij `stops_te_doen < stops_totaal` (chauffeur heeft z'n eerste stop afgeleverd) én er nog geen starttijd stond.
- **Eind — continu bijgewerkt, niet pas ná bevestiging** (sinds 2026-08-24): zolang `status !== 'gereden'`, wordt `postnl_eind_werktijd` op **elke poll** overschreven met de laatst gelezen `postnl_laatste_actie` (via `nlTijdstipNaarIso()`). Dit is een voorlopige waarde — "laatst bekende actie", niet per se "dienst afgerond". Reden voor deze ontwerpwijziging: als de polling zelf stopt (VPS-crash-loop, dispatch-storing, per-depot-uitval — allemaal live aangetroffen tijdens de troubleshoot-sessie van 24/25 aug 2026 die tot deze repo-migratie leidde) vóórdat een van de twee onderstaande afrond-paden kan vuren, bleef `postnl_eind_werktijd` voorheen voor altijd `null`. Nu blijft in elk geval de laatst gelezen waarde staan.
  - **Front-end-conventie** (`eindtijdOnbevestigd()` in matransport's `RitDetail.jsx`/`Financien/index.jsx`): een `!` achter de eindtijd verschijnt **alleen** als `status !== 'gereden'` **én** de datum van de rit al in het verleden ligt — een rit van vandaag die nog gewoon bezig is, is geen probleem en krijgt geen waarschuwing. Pas zodra de dag voorbij is zonder bevestigde afronding is dit een signaal dat er iets misging. Baseer je nooit op "is `postnl_eind_werktijd` gevuld?" om te bepalen of een rit echt klaar is — gebruik altijd `status === 'gereden'`.
  - `status` wordt zelf pas op `'gereden'` gezet door een van de twee paden hieronder — die blijven ongewijzigd verantwoordelijk voor de **bevestiging**, niet voor de eindtijd-waarde zelf (die staat door de continue update al klaar).
  1. **Bevestigd-nul**: `stops_te_doen` is twee polls op rij `0` (`stopsTeDoenBevestigdNul` in `opslaanMonitorInSupabase()`). Één keer 0 wordt niet vertrouwd — een vers aangemaakte rij toont soms eenmalig foutief 0 vóór de echte waarde laadt; zonder die dubbele bevestiging werd de rit veel te vroeg afgerond (eind vlak na start). Val terug op `nu` als `postnl_laatste_actie` onverwacht onparseerbaar is.
  2. **Verdwenen uit de grid**: PostNL haalt een rit uit Ritmonitor zodra de chauffeur klaar is, vaak zonder ooit "0 te doen" te tonen (onbezorgbare stops blijven "te doen") — dit pad bestaat juist om dát geval te dekken, met `postnl_laatste_actie` als eindtijd ongeacht hoeveel er nog "te doen" staat. Een rit die ≥ 20 min (`AFWEZIG_DREMPEL_MIN`, ≈ 3 gemiste polls bij de huidige cron) niet meer in de grid stond, was onderweg (voortgang gemaakt) en nog geen eindtijd had, wordt alsnog afgerond. Eindtijd is hier bewust niet het detectiemoment zelf (dat ligt per definitie ≥ 20 min later) — met een plausibiliteitscheck (niet vóór de starttijd) en terugval op `postnl_monitor_opgehaald` als die tijd ontbreekt/onplausibel is.
  - Alleen actief als de scrape zelf rijen opleverde — een lege lijst is waarschijnlijk een mislukte/half-geladen grid, dan wordt er niets afgerond (een half-geladen grid liet ooit bezige ritten eenmalig verdwijnen → vals afgerond, vandaar de dubbele-miss-eis).

**Gebruikt door (in `fixertnl/matransport`):** `src/pages/Ritten/RitDetail.jsx`/`index.jsx` (live werktijd-timer + weergave), `src/pages/Financien/index.jsx` (`getRitUren()`) en `src/lib/rittenMaandExport.js` (overwerkberekening). `postnl_uren` (AI-gescand dagrapport) heeft altijd voorrang; deze kolommen zijn de terugval.

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

- **Timeout 10 minuten** (`timeout-minutes` in de workflow) — een run hoort in 1-2 min klaar te zijn.
- **Geen skip-if-busy nodig** zoals bij de oude VPS-opzet — elke GitHub Actions-run krijgt zijn eigen geïsoleerde container, dus overlappende runs schrijven elkaar niet in de weg op procesniveau (al kunnen ze wel dezelfde DB-rijen raken bij een korte overlap — dezelfde dubbele-miss-bevestiging hierboven vangt dat af).
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

Grotendeels identiek aan de boilerplate in `worker/postnl-sync/` (bewust — zie header-comment in `src/index.js`):

- **`serviceWorkers: 'block'`** in de Playwright-context — de Mendix service-worker veroorzaakt anders herlaad-/chrome-error-loops vlak na de OAuth-redirect.
- **"Tijdstip laatste actie" wisselt van tijdzone — UTC of NL-lokaal, niet voorspelbaar welke** (ontdekt 2026-08-24, tweede keer geraakt 2026-08-25, ondanks dat elke run hier een vers container-filesystem krijgt — dus **geen** sessie-hergebruik als verklaring, in tegenstelling tot wat op de vroegere VPS werd vermoed). Op 24 aug consistent UTC (gemeten door een live scrape naast een live screenshot te leggen: alle vergeleken ritten precies 2:00 verschil). Minder dan 24 uur later, zonder enige codewijziging, bleek de tekst NL-lokaal — een rit kreeg daardoor een `postnl_eind_werktijd` die **in de toekomst** lag (rit 905, 25 aug: "21:47"-tekst → opgeslagen als 21:47 UTC = 23:47 NL, terwijl het scrape-moment zelf pas 22:16 NL was).
  - **Oorzaak niet hard vastgesteld** — mogelijk iets serverzijdig bij Mendix (load-balancer/regio-afhankelijk?), niet gerelateerd aan sessie-caching zoals eerst gedacht.
  - **Definitieve fix — niet meer gokken welke tijdzone, zelf detecteren:** `nlTijdstipNaarIso(datum, tekst, nuMs)` berekent **beide** interpretaties (als-UTC en als-NL-lokaal), verwerpt de kandidaat die ná `nuMs` (het scrape-moment) zou liggen — een "laatste actie" kan per definitie nooit in de toekomst liggen — en kiest bij twijfel de meest recente overgebleven kandidaat. Geen enkele aanroep hoeft nog een tijdzone te *kiezen*.
  - Check bij een vergelijkbare klacht ("de tijden kloppen niet", "eindtijd ligt in de toekomst") eerst of `nlTijdstipNaarIso()` zelf het probleem al oplost vóórdat je een andere oorzaak zoekt — vergelijk de rauwe tekst met `postnl_monitor_opgehaald` van dezelfde run om te zien welke interpretatie plausibel is.
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

`syncRitmonitor()` loopt depots sequentieel af en isoleert fouten: één depot dat faalt (trage grid, sessie-redirect) stopt niet de hele run — de overige depots draaien gewoon door. Alleen als **alle** depots falen gooit de run alsnog een fout. Chauffeur-koppeling draait ook bij gedeeltelijk succes.

## Run-monitoring (`worker_run_log`)

`syncRitmonitor()` schrijft naast de console.log-regels ook een gestructureerde rij naar de Supabase-tabel `public.worker_run_log` (matransport migration_v150, generiek per worker, `worker_naam`-kolom):
- **INSERT bij start** (`startRunLog()`) — `status: 'gestart'`. Een gecrashte run die de UPDATE nooit haalt, blijft dus zichtbaar als "gestart maar nooit afgerond".
- **UPDATE bij einde** (`eindeRunLog()`) — `status: 'ok'/'deels_mislukt'/'mislukt'`, `depots_ok`, `depots_mislukt` (jsonb-array van `{depot, fout}`-objecten), `rijen_gelezen`.
- Beide functies zijn **best-effort** (eigen try/catch) — een logging-probleem mag de eigenlijke sync nooit blokkeren.

**Staleness-alert**: `public.check_worker_staleness()` (pg_cron in matransport's Supabase-project, elke 15 min, 06:15–22:55 NL-tijd) checkt of de laatste succesvolle run niet ouder is dan 20 minuten en pusht zo nodig naar de admins. Werkt automatisch voor deze GitHub-Actions-runs, want ze schrijven naar dezelfde database met dezelfde `worker_naam` — geen aparte configuratie nodig.
