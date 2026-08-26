// ============================================================
// POSTNL RITMONITOR-WORKER (zelfstandig, eigen proces/poort).
// Leest elke 5 min de live voortgang uit Planning → Ritmonitor:
// "Aantal stops" + "Stops te doen" + "Tijdstip laatste actie" per rit,
// en schrijft dat naar de ritten-tabel (postnl_stops_totaal e.d.).
//
// Standaard-code (config, helpers, login, depots, sessie) is bewust
// IDENTIEK aan worker/postnl-sync — elke worker is zelfstandig.
//
// Draaien:
//   npm start              → daemon: HTTP POST /sync-monitor (+ optionele cron)
//   npm run sync:once      → één keer draaien en stoppen (test)
// ============================================================

import 'dotenv/config'
import cron from 'node-cron'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'

// Optionele proxy — PostNL's Akamai-beveiliging blokkeert het IP van de
// scrape-omgeving bij te veel geautomatiseerd verkeer vanaf één vast adres.
// Hier grotendeels overbodig (elke GitHub Actions-run heeft al een ander IP
// uit de pool), maar blijft bewust beschikbaar als extra beveiligingslaag.
// Zet in GitHub Secrets (leeg = direct verbinden, ongewijzigd gedrag):
//   PROXY_SERVER=http://gateway.provider.com:7000
//   PROXY_USERNAME / PROXY_PASSWORD (optioneel)
// Was worker/postnl-shared/proxy.js (gedeeld met postnl-dagplanning) — nu per
// worker ingebouwd, want een map voor 15 regels code die door precies twee
// bestanden gebruikt wordt voegde meer verwarring toe dan het oploste.
function metProxy(launchOptions, label = '') {
  const server = process.env.PROXY_SERVER
  if (!server) return launchOptions
  const proxy = { server }
  if (process.env.PROXY_USERNAME) proxy.username = process.env.PROXY_USERNAME
  if (process.env.PROXY_PASSWORD) proxy.password = process.env.PROXY_PASSWORD
  launchOptions.proxy = proxy
  console.log(`${label ? `[${label}] ` : ''}Proxy actief: ${proxy.server}`)
  return launchOptions
}

const CONFIG = {
  timezone: process.env.TZ || 'Europe/Amsterdam',
  headless: String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false',
  slowMo: Number(process.env.POSTNL_SLOWMO || 0),
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Ontbrekende env variabele: ${name}`)
  return value
}

const supabase = createClient(
  requireEnv('SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } }
)

const KLANT_ID = requireEnv('KLANT_ID')

function vandaagNl() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day}`
}

function normaliseerRitnummer(value) {
  const digits = String(value || '').match(/\d+/)?.[0] || ''
  return digits ? String(parseInt(digits, 10)) : ''
}

function toNumber(value) {
  if (!value) return null
  const n = Number(String(value).trim().replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Zet een "HH:MM"-wandkloktijd uit de Ritmonitor-kolom "Tijdstip laatste actie"
// om naar een ISO-timestamp. De datum is altijd de scrape-dag. Retourneert
// null bij onparseerbaar of als geen van beide interpretaties plausibel is.
//
// LET OP — de tijdzone waarin deze tekst gerenderd wordt, wisselt: soms UTC,
// soms NL-lokaal (CEST). Op 2026-08-24 was 't consistent UTC (gemeten door een
// live scrape naast een live screenshot te leggen); nog geen 24u later, op
// 2026-08-25, bleek 't zonder enige codewijziging omgeslagen naar NL-lokaal —
// vermoedelijk hangt Mendix de tijdzone bij het inloggen aan de sessie, en
// verandert dat zodra de hergebruikte `storageState`-sessie (zie
// openDepotSessie) een keer opnieuw moet inloggen. Hardcoded op één
// interpretatie gokken bleek dus niet houdbaar: dit rekent daarom BEIDE
// interpretaties uit en kiest de plausibele — een "laatste actie" kan nooit
// ná het scrape-moment (nuMs) liggen, dus die kandidaat valt af. Blijven er
// twee over (bv. bij een echte UTC-tekst is "als-NL-lokaal" toevallig ook
// niet in de toekomst, want 2 uur eerder), dan wint de meest recente — de
// juiste interpretatie ligt vrijwel altijd dichter bij het scrape-moment dan
// de foute (die 2 uur verder terug zou liggen).
function nlTijdstipNaarIso(datum, tekst, nuMs = Date.now()) {
  const m = String(tekst || '').match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const alsUtc = new Date(`${datum}T${m[1].padStart(2, '0')}:${m[2]}:00Z`)
  if (Number.isNaN(alsUtc.getTime())) return null

  const offsetNaam = new Intl.DateTimeFormat('en', { timeZone: CONFIG.timezone, timeZoneName: 'longOffset' })
    .formatToParts(alsUtc).find(p => p.type === 'timeZoneName')?.value || ''
  const om = offsetNaam.match(/([+-])(\d{2}):(\d{2})/)
  const offsetMin = om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : 0
  const alsNlLokaal = new Date(alsUtc.getTime() - offsetMin * 60000)

  const kandidaten = [alsUtc, alsNlLokaal]
    .filter(d => d.getTime() <= nuMs)
    .sort((a, b) => b.getTime() - a.getTime())
  return kandidaten[0]?.toISOString() ?? null
}

async function loginPostnl(page, depot) {
  console.log(`[${depot.naam}] Login pagina URL:`, page.url())
  await page.locator('input[type="text"], input[type="email"]').first().waitFor({ timeout: 15000 })
  await page.locator('input[type="text"], input[type="email"]').first().fill(depot.username)
  await page.locator('input[type="password"]').first().fill(depot.password)
  await page.locator('button[data-trn-key="login.butlogin"]').click()
  // Wacht tot we van de loginpagina af zijn. NIET op '**pnl-oompd**' wachten:
  // de login-URL bevat die string zelf (in de redirect-param) → vals-positief.
  await page.waitForFunction(() => !window.location.hostname.includes('loginpostnl'), { timeout: 90000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  if (page.url().includes('loginpostnl')) throw new Error(`Login mislukt. URL na login: ${page.url()}`)
  console.log(`[${depot.naam}] Ingelogd, URL:`, page.url())
}

// Opent browser + context (met opgeslagen sessie indien aanwezig) + page,
// navigeert naar het depot en logt in indien nodig.
async function openDepotSessie(depot) {
  const launchOptions = { headless: CONFIG.headless, slowMo: CONFIG.slowMo, args: ['--disable-dev-shm-usage'] }
  if (process.env.CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  metProxy(launchOptions, depot.naam)
  const browser = await chromium.launch(launchOptions)

  // serviceWorkers blokkeren: de Mendix service-worker veroorzaakt anders
  // herlaad-/chrome-error-loops vlak na de OAuth-redirect.
  // timezoneId expliciet zetten: zonder dit rendert Mendix "Tijdstip laatste
  // actie" client-side in de systeem-tijdzone van de scrape-browser i.p.v.
  // NL-lokale tijd — gaf een structureel 2 uur (CEST) verschil met wat een
  // mens op de site ziet, en dat plantte zich door in postnl_eind_werktijd
  // (via nlTijdstipNaarIso, die de tekst juist als NL-lokaal interpreteert).
  const contextOptions = { serviceWorkers: 'block', timezoneId: CONFIG.timezone }
  try {
    const fsSync = await import('node:fs')
    if (depot.storageState && fsSync.existsSync(depot.storageState)) contextOptions.storageState = depot.storageState
  } catch {}

  // Video-opname van de sessie — op verzoek, zodat je kan meekijken in de
  // browser zonder zelf POSTNL_HEADLESS=false te hoeven draaien. Bewaard via
  // bewaarSessieVideo() na afloop (overwrite-latest per depot, zie migration_v156).
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessie-video-'))
  contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } }

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  if (page.url().includes('loginpostnl') || page.url().includes('/login') || page.url().includes('/authorize')) {
    await loginPostnl(page, depot)
  }
  return { browser, context, page }
}

// Koppelt chauffeur_id aan postnl_chauffeur — en corrigeert 'm ook als 'ie al
// gezet was (geen .is('chauffeur_id', null) meer, sinds 2026-08-24). Een rit
// mag nooit een andere chauffeur_id hebben dan wie PostNL's eigen data zegt
// dat er reed — dat veld bepaalt wie voor de stops betaald krijgt. Zonder
// deze correctie bleef een rit voor altijd aan de eerst-gekoppelde chauffeur
// hangen, ook als er in werkelijkheid een chauffeurwissel was (bv. rit 333 op
// 12 aug 2026: chauffeur_id wees naar Mulubrhan Haile terwijl postnl_chauffeur
// al lang "Saboune, Y." zei — nooit gecorrigeerd doordat de oude .is(null)
// -guard elke volgende sync blokkeerde).
//
// Dit botst niet met de oorspronkelijke reden voor die guard (issue #71: een
// handmatige herindeling via RitForm/RitDetail mag niet worden teruggedraaid)
// — .eq('postnl_chauffeur', u.postnl_naam) matcht sowieso nooit een rit met
// postnl_chauffeur = null, en dat is precies het geval bij @Home/freelance-
// ritten (geen PostNL-account, dus nooit een postnl_chauffeur-waarde) waar
// handmatige chauffeur-wissel voor bedoeld is. Regulier gescrapete ritten
// hébben altijd een postnl_chauffeur-waarde zodra ze in de Ritmonitor-grid
// verschijnen, en daar is die waarde leidend.
async function koppelChauffeurs() {
  const klantId = KLANT_ID
  const { data: users } = await supabase
    .from('users').select('id, postnl_naam')
    .eq('klant_id', klantId)
    .not('postnl_naam', 'is', null).neq('postnl_naam', '')
  if (!users?.length) return
  let totaal = 0
  for (const u of users) {
    // .or(...) matcht alleen rijen die écht een andere chauffeur_id nodig
    // hebben (null, of een andere waarde) — puur om onnodige writes en een
    // opgeblazen "X bijgewerkt"-log te vermijden. Niet nodig voor correctheid:
    // de DB-trigger trg_notify_rit_toegewezen (migration_v139) no-opt zelf al
    // bij een ongewijzigde waarde, dus een overbodige write zou sowieso geen
    // dubbele pushmelding veroorzaken.
    const { data } = await supabase.from('ritten')
      .update({ chauffeur_id: u.id })
      .eq('klant_id', klantId)
      .eq('postnl_chauffeur', u.postnl_naam)
      .or(`chauffeur_id.is.null,chauffeur_id.neq.${u.id}`)
      .select('id')
    totaal += data?.length ?? 0
  }
  if (totaal > 0) console.log(`Chauffeurs gekoppeld/gecorrigeerd: ${totaal} ritten bijgewerkt`)
}

// ---- Ritmonitor-specifiek ---------------------------------------

// Navigeert naar Planning → Ritmonitor. De Riteigenaar-grid (M&A Transport)
// is daar al geselecteerd — daar NIET op klikken, anders deselecteer je 'm.
async function openRitmonitor(page, depot) {
  const depotUrl = depot.url
  const planningLoc = () => page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first()
  const isOAuth = () => page.url().includes('loginpostnl') || page.url().includes('/authorize')

  // Mendix start de OAuth-redirect soms pas ná de goto (tijdens het laden van de app),
  // waardoor een URL-check na goto het mist. Oplossing: poll elke seconde totdat het
  // Planning-menu zichtbaar is of OAuth gedetecteerd wordt — dan herlogin en ga door.
  async function waitForPlanning(maxMs = 90000) {
    const deadline = Date.now() + maxMs
    let herlogins = 0
    while (Date.now() < deadline) {
      if (isOAuth()) {
        if (herlogins >= 3) throw new Error(`Planning-menu niet bereikbaar na ${herlogins} herlogins`)
        herlogins++
        console.log(`[${depot.naam}] OAuth-redirect gedetecteerd (herlogin ${herlogins})...`)
        await loginPostnl(page, depot)
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(2000)
        continue
      }
      if (await planningLoc().isVisible()) return
      await page.waitForTimeout(1000)
    }
    throw new Error(`Planning-menu niet zichtbaar na ${maxMs / 1000}s (url: ${page.url()})`)
  }

  await page.goto(depotUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2000)
  await waitForPlanning()

  await planningLoc().click()
  await page.waitForTimeout(600)
  await page.locator('a[title="Ritmonitor"]').first().click()
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

async function leesRitmonitor(page) {
  const result = await page.evaluate(() => {
    function cel(row, cls) {
      return row.querySelector(`td.${cls}`)?.getAttribute('title')?.trim() || ''
    }
    // De overview-grid is de tabel met kolomkop "Stops te doen" (column16).
    // Zo onderscheiden we 'm van de Riteigenaar-grid (column5) links.
    const tables = Array.from(document.querySelectorAll('.mx-grid-content table'))
    const target = tables.find(t => t.querySelector('th[title="Stops te doen"]'))
    if (!target) return { rows: [], debug: 'Ritmonitor overview-grid niet gevonden' }

    // Brievenbuss kolom dynamisch opzoeken via header-titel — het kolomnummer
    // kan per Mendix-instantie verschillen van de Overview-shift-grid.
    const brievenbussCol = (() => {
      const th = Array.from(target.querySelectorAll('thead th')).find(
        h => /brievenbuss/i.test(h.getAttribute('title') || h.textContent || '')
      )
      return th ? Array.from(th.classList).find(c => c.startsWith('mx-name-column')) : null
    })()

    const trs = Array.from(target.querySelectorAll('tbody tr[data-id]'))
    const mapped = trs.map(row => ({
      kanaal:          cel(row, 'mx-name-column1'),
      ritnaam:         cel(row, 'mx-name-column2'),
      chauffeur:       cel(row, 'mx-name-column3'),
      laatsteActie:    cel(row, 'mx-name-column15'),
      stopsTotaal:     cel(row, 'mx-name-column6'),
      stopsTeDoen:     cel(row, 'mx-name-column16'),
      brievenbusstops: brievenbussCol ? cel(row, brievenbussCol) : '',
    }))
    const f = mapped[0]
    return { rows: mapped, debug: `${mapped.length} rijen, eerste={ritnaam:"${f?.ritnaam}",totaal:"${f?.stopsTotaal}",teDoen:"${f?.stopsTeDoen}",brievenbuss:"${f?.brievenbusstops}",col:"${brievenbussCol}"}` }
  })
  console.log(`[DEBUG ritmonitor] ${result.debug}`)

  return result.rows
    .filter(r => r.ritnaam && /^\d{3,4}/.test(r.ritnaam) && toNumber(r.stopsTotaal) !== null)
    .map(r => {
      const ritnummer = normaliseerRitnummer(r.ritnaam.match(/^\d+/)?.[0] || '')
      return {
        ritnummer,
        ritnaam:         r.ritnaam,
        chauffeur:       r.chauffeur || null,
        kanaal:          r.kanaal || null,
        laatsteActie:    r.laatsteActie || null,
        stopsTotaal:     toNumber(r.stopsTotaal),
        stopsTeDoen:     toNumber(r.stopsTeDoen),
        brievenbusstops: toNumber(r.brievenbusstops),
        shift:           ritnummer.charAt(0) || null,
      }
    })
}

async function opslaanMonitorInSupabase(rijen, datum, depotNaam) {
  const nu = new Date().toISOString()
  const klantId = KLANT_ID

  const { data: bestaande } = await supabase
    .from('ritten')
    .select('id, ritnummer, status, postnl_stops_totaal, postnl_stops_te_doen, postnl_start_werktijd, postnl_eind_werktijd, postnl_monitor_opgehaald, postnl_laatste_actie')
    .eq('datum', datum).eq('depot', depotNaam)

  // Eerste rij per genormaliseerd ritnummer (dedup zoals de hoofd-sync).
  const bestaandeMap = new Map()
  for (const r of bestaande ?? []) {
    const key = String(parseInt(r.ritnummer, 10))
    if (!bestaandeMap.has(key)) bestaandeMap.set(key, r)
  }

  const teUpdaten = []
  const teInserten = []
  const logRijen = []
  const runContext = {
    klant_id: klantId,
    depot: depotNaam,
    datum,
    rijen_gelezen: rijen.length,
    lege_lijst_bevestigd: false,
    bestaande_ritten: bestaande?.length ?? 0,
  }

  for (const rit of rijen) {
    const existing = bestaandeMap.get(rit.ritnummer)

    // Een 0-meting pas vertrouwen als "klaar" zodra de vóórgaande poll dat ook al liet zien.
    // Bij een net aangemaakte rij toont de Mendix-grid de "stops te doen"-cel soms eenmalig
    // foutief 0 voordat de echte waarde laadt — zonder deze bevestiging wordt de rit dan
    // veel te vroeg als afgerond gemarkeerd (eind_werktijd vlak na start_werktijd).
    const stopsTeDoenBevestigdNul = rit.stopsTeDoen === 0 && existing?.postnl_stops_te_doen === 0

    const velden = {
      postnl_stops_totaal:      rit.stopsTotaal,
      postnl_stops_te_doen:     rit.stopsTeDoen,
      postnl_laatste_actie:     rit.laatsteActie,
      postnl_kanaal:            rit.kanaal,
      postnl_chauffeur:         rit.chauffeur,
      postnl_monitor_opgehaald: nu,
      ...(rit.brievenbusstops !== null && { postnl_briefbusstops: rit.brievenbusstops }),
      // Status op basis van ritmonitor: ritmonitor is leidend zodra stops_te_doen bekend is.
      ...(rit.stopsTeDoen !== null && {
        status: stopsTeDoenBevestigdNul ? 'gereden' : 'bezig',
      }),
    }

    // Starttijd: eerste sync waarbij chauffeur een stop heeft afgeleverd.
    if (
      rit.stopsTeDoen !== null &&
      rit.stopsTotaal !== null &&
      rit.stopsTeDoen < rit.stopsTotaal &&
      !existing?.postnl_start_werktijd
    ) {
      velden.postnl_start_werktijd = nu
    }

    // Eindtijd: continu bijgewerkt naar de laatst gelezen "tijdstip laatste actie",
    // zolang de rit nog niet definitief 'gereden' is (niet pas ná bevestiging via
    // bevestigd-nul of verdwenen-uit-grid hieronder). Reden: als de polling zelf
    // ooit stopt — VPS-crash, dispatch-storing, per-depot-uitval, zie git-historie
    // 2026-08-24 — vóórdat een van die twee paden kan vuren, bleef eind_werktijd
    // voorheen voor altijd null, terwijl we allang een laatst bekende actie-tijd
    // hadden. Nu blijft in elk geval de laatste gelezen waarde staan.
    //
    // BELANGRIJK: dit is dus niet per se een bevestigde eindtijd — pas zodra
    // status === 'gereden' is die bevestigd (via bevestigd-nul of verdwenen-uit-
    // grid). Zolang status 'bezig' blijft, is dit een voorlopige waarde (chauffeur
    // kan nog bezig zijn — dit is dan gewoon zijn laatst bekende actie, geen
    // afgeronde dienst). Front-end moet dat onderscheid tonen (bv. een "!" achter
    // de tijd) zolang status niet 'gereden' is — zie RITTEN_ARCHITECTUUR.md.
    if (existing?.postnl_start_werktijd && existing?.status !== 'gereden') {
      const actieIso = nlTijdstipNaarIso(datum, rit.laatsteActie, new Date(nu).getTime())
      if (actieIso) velden.postnl_eind_werktijd = actieIso
    }

    // Diagnostisch loggen: wat las de worker + welke beslissing nam hij voor deze rit.
    const actie = !existing ? 'nieuw'
      : stopsTeDoenBevestigdNul ? 'eind-nul'
      : velden.postnl_start_werktijd ? 'start-gezet'
      : velden.postnl_eind_werktijd ? 'eind-bijgewerkt'
      : 'gelezen'
    logRijen.push({
      ...runContext,
      ritnummer:     rit.ritnummer,
      stops_totaal:  rit.stopsTotaal,
      stops_te_doen: rit.stopsTeDoen,
      laatste_actie: rit.laatsteActie,
      actie,
    })

    if (existing) {
      teUpdaten.push({ id: existing.id, velden })
    } else {
      // Rit nog niet via Dagplanning aangemaakt → minimale rij zodat het live toch toont.
      teInserten.push({
        datum,
        status:    'gepland',
        shift:     rit.shift,
        ritnummer: rit.ritnummer,
        depot:     depotNaam,
        klant_id:  klantId,
        postnl_ritnaam: rit.ritnaam,
        ...velden,
      })
    }
  }

  // ── Verdwenen-uit-grid → afronden (veilig, met dubbele-miss-bevestiging) ──
  // PostNL haalt een rit uit de Ritmonitor-grid zodra de chauffeur klaar is.
  // Zo'n rit bereikt "te doen = 0" vaak nooit (onbezorgbare stops blijven staan),
  // dus de nul-detectie hierboven pakt 'm niet — zonder deze pass blijft hij eeuwig
  // op zijn laatste "te doen"-waarde hangen en toont "bezig · N te gaan" terwijl de
  // chauffeur allang klaar is (de bug bij o.a. rit 640).
  //
  // Waarom de oude simpele "verdwenen → gereden" ooit is verwijderd: een half-geladen
  // Mendix-grid liet bezige ritten eenmalig verdwijnen → die werden dan vals afgerond.
  // Daarom eisen we nu dat de rit al MEERDERE polls niet meer gezien is, af te leiden
  // uit de ouderdom van postnl_monitor_opgehaald (die ververst elke keer dat we 'm
  // lezen). Een transient half-geladen grid herstelt de volgende poll → timer reset.
  const AFWEZIG_DREMPEL_MIN = 20   // ≈ 3 gemiste polls bij de 7-min-cron
  const gelezenNummers = new Set(rijen.map(r => r.ritnummer))

  // Alleen zinvol als deze scrape zelf rijen opleverde — een lege lijst is
  // waarschijnlijk een mislukte/half-geladen grid; dan niets afronden.
  if (rijen.length > 0) {
    for (const [key, r] of bestaandeMap) {
      if (gelezenNummers.has(key)) continue                    // nog in de grid
      // 'gereden' is de enige "al afgerond"-check — postnl_eind_werktijd staat
      // inmiddels vrijwel altijd al gevuld (continue update hierboven, zie
      // 2026-08-24), dus die kan niet meer als "al klaar"-signaal dienen.
      if (r.status === 'gereden') continue                     // al afgerond
      if (!r.postnl_start_werktijd) continue                   // nooit begonnen
      if (r.postnl_stops_totaal == null) continue
      // Was hij echt onderweg? (voortgang gemaakt, niet nog volledig "te doen")
      if (!(r.postnl_stops_te_doen != null && r.postnl_stops_te_doen < r.postnl_stops_totaal)) continue
      // Dubbele-miss-bevestiging via ouderdom van de laatste meting.
      const opgehaald = r.postnl_monitor_opgehaald ? new Date(r.postnl_monitor_opgehaald).getTime() : 0
      if ((Date.now() - opgehaald) / 60000 < AFWEZIG_DREMPEL_MIN) continue

      // Eindtijd: NIET het detectiemoment (dat ligt ≥20 min ná het echte einde),
      // maar PostNL's eigen "Tijdstip laatste actie" — de laatste bezorghandeling
      // van de chauffeur. "Niet in de toekomst" wordt al binnen nlTijdstipNaarIso()
      // zelf afgedwongen; hier blijft alleen de "niet vóór de starttijd"-check over
      // (die kent de functie zelf niet). Onplausibel → terugval op laatst-gezien-tijd.
      const laatsteActieIso = nlTijdstipNaarIso(datum, r.postnl_laatste_actie, new Date(nu).getTime())
      const actieMs = laatsteActieIso ? new Date(laatsteActieIso).getTime() : null
      const startMs = r.postnl_start_werktijd ? new Date(r.postnl_start_werktijd).getTime() : null
      const actiePlausibel = actieMs !== null && (startMs === null || actieMs >= startMs)
      const eindtijd = actiePlausibel ? laatsteActieIso : (r.postnl_monitor_opgehaald || nu)

      teUpdaten.push({ id: r.id, velden: {
        status: 'gereden',
        postnl_eind_werktijd: eindtijd,
        postnl_monitor_opgehaald: nu,
      } })
      logRijen.push({
        ...runContext,
        ritnummer:     key,
        stops_totaal:  r.postnl_stops_totaal,
        stops_te_doen: r.postnl_stops_te_doen,
        laatste_actie: r.postnl_laatste_actie ?? null,
        actie:         'verdwenen-afgerond',
      })
    }
  }

  console.log(`[${depotNaam}] Ritmonitor-run: ${rijen.length} gelezen, ${bestaande?.length ?? 0} bestaand`)

  await Promise.all([
    ...teUpdaten.map(({ id, velden }) => supabase.from('ritten').update(velden).eq('id', id)),
    teInserten.length ? supabase.from('ritten').insert(teInserten) : Promise.resolve(),
    logRijen.length ? supabase.from('ritmonitor_log').insert(logRijen) : Promise.resolve(),
  ])

  console.log(`[${depotNaam}] Ritmonitor ${datum}: bijgewerkt ${teUpdaten.length}, nieuw ${teInserten.length}`)
}

// Slaat de zojuist opgenomen sessie-video op in de private bucket
// worker-sessies (migration_v156) — overwrite-latest per depot (vast pad,
// geen timestamp), zodat opslag begrensd blijft tot één video per depot i.p.v.
// een onbeperkt groeiend archief. Geeft het storage-pad terug, of null als er
// geen video was of het opslaan mislukte (nooit de sync zelf laten falen op
// een video-probleem).
async function bewaarSessieVideo(video, depotNaam) {
  if (!video) return null
  let localPath
  try {
    localPath = await video.path()
    const buffer = await fs.readFile(localPath)
    const slug = depotNaam.toLowerCase().replace(/\s+/g, '-')
    const storagePath = `${KLANT_ID}/postnl-ritmonitor/${slug}-latest.webm`
    const { error } = await supabase.storage.from('worker-sessies')
      .upload(storagePath, buffer, { contentType: 'video/webm', upsert: true })
    if (error) throw error
    console.log(`[${depotNaam}] Sessie-video opgeslagen: ${storagePath}`)
    return storagePath
  } catch (error) {
    console.error(`[${depotNaam}] Video-opslag mislukt (sync gaat gewoon door):`, error.message)
    return null
  } finally {
    if (localPath) await fs.unlink(localPath).catch(() => {})
  }
}

async function syncMonitorDepot(depot) {
  const vandaag = vandaagNl()
  console.log(`[${depot.naam}] Ritmonitor sync voor ${vandaag}`)

  const { browser, context, page } = await openDepotSessie(depot)
  let rijenAantal = 0
  let fout = null
  try {
    await page.waitForTimeout(1000)
    await openRitmonitor(page, depot)
    const rijen = await leesRitmonitor(page)
    console.log(`[${depot.naam}] Ritmonitor: ${rijen.length} ritten gelezen`)
    await opslaanMonitorInSupabase(rijen, vandaag, depot.naam)

    if (depot.storageState) await context.storageState({ path: depot.storageState })
    rijenAantal = rijen.length
  } catch (error) {
    console.error(`[${depot.naam}] Ritmonitor sync mislukt:`, error)
    fout = error
  }

  // Video pas na context.close() ophalen — Playwright rondt het bestand pas
  // dan af, ervoor kan het nog onvolledig op schijf staan.
  const video = page.video()
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  const videoPath = await bewaarSessieVideo(video, depot.naam)

  if (fout) { fout.videoPath = videoPath; throw fout }
  return { rijen: rijenAantal, videoPath }
}

// Gestructureerd run-niveau-logboek in `worker_run_log` (migration_v150) —
// ontstaan uit een troubleshoot-sessie waarin de PM2-console-logs structureel
// geen ritmonitor-activiteit bleken te tonen (onverklaard, los probleem) en er
// geen enkel run-niveau-overzicht bestond ("draait dit eigenlijk nog?"). Eén
// rij per run: INSERT bij start, UPDATE bij einde. Een gecrashte run die nooit
// de UPDATE haalt blijft zichtbaar als "gestart maar nooit afgerond" — net zo'n
// signaal als een expliciete fout. Best-effort: een logging-fout mag de
// eigenlijke sync nooit blokkeren.
// GitHub Actions zet deze env-vars automatisch (server-url/repo/run-id) — geeft
// een directe link terug naar de Actions-log van deze run, zodat je bij een
// mislukte run niet meer handmatig door `gh run list` hoeft te zoeken naar het
// juiste tijdstip. null buiten GitHub Actions (bv. lokaal testen).
function githubRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

async function startRunLog() {
  try {
    const { data } = await supabase.from('worker_run_log')
      .insert({ worker_naam: 'postnl-ritmonitor', klant_id: KLANT_ID, run_url: githubRunUrl() })
      .select('id').single()
    return data?.id ?? null
  } catch (error) {
    console.error('startRunLog mislukt (sync gaat gewoon door):', error.message)
    return null
  }
}

async function eindeRunLog(runLogId, velden) {
  if (!runLogId) return
  try {
    await supabase.from('worker_run_log').update({ afgerond_at: new Date().toISOString(), ...velden }).eq('id', runLogId)
  } catch (error) {
    console.error('eindeRunLog mislukt:', error.message)
  }
}

async function syncRitmonitor() {
  const runLogId = await startRunLog()
  const DEPOTS = await getDepots(supabase, KLANT_ID, 'postnl')
  if (DEPOTS.length === 0) {
    await eindeRunLog(runLogId, { status: 'mislukt', foutmelding: 'Geen depots geconfigureerd' })
    throw new Error('Geen depots geconfigureerd (klant_credentials leeg voor deze klant)')
  }

  // Per-depot isoleren: een transiente time-out bij één depot (trage Mendix-
  // grid / sessie-redirect) mag de hele 10-min-run niet laten falen wanneer de
  // andere depots wél slagen. Alleen falen als ALLE depots faalden.
  //
  // De foutmelding gaat hier bewust ook naar worker_run_log (depot + error.message),
  // niet alleen naar console.error — tijdens een instabiele periode (VPS-crash-loop,
  // zie 12 aug 2026) kan de console-log wegvallen vóórdat 'ie geflushed is, terwijl
  // een DB-write via een losse request altijd aankomt of hard faalt (geen stille
  // dataverlies-situatie zoals bij een gebufferde stdout-stream).
  const mislukt = []
  let rijenTotaal = 0
  const videoPaths = []
  for (const depot of DEPOTS) {
    try {
      const { rijen, videoPath } = await syncMonitorDepot(depot)
      rijenTotaal += rijen
      if (videoPath) videoPaths.push({ depot: depot.naam, storage_path: videoPath })
    } catch (error) {
      mislukt.push({ depot: depot.naam, fout: error.message })
      if (error.videoPath) videoPaths.push({ depot: depot.naam, storage_path: error.videoPath })
      console.error(`[${depot.naam}] Ritmonitor overgeslagen na fout (volgende depot gaat door):`, error.message)
    }
  }

  if (mislukt.length === DEPOTS.length) {
    await eindeRunLog(runLogId, {
      status: 'mislukt', depots_ok: 0, depots_mislukt: mislukt, rijen_gelezen: rijenTotaal,
      foutmelding: `Alle depots faalden: ${mislukt.map(m => `${m.depot} (${m.fout})`).join('; ')}`,
      video_paths: videoPaths.length ? videoPaths : null,
    })
    throw new Error(`Ritmonitor: alle depots faalden (${mislukt.map(m => m.depot).join(', ')})`)
  }

  await koppelChauffeurs()
  const depotsOk = DEPOTS.length - mislukt.length
  await eindeRunLog(runLogId, {
    status: mislukt.length ? 'deels_mislukt' : 'ok',
    depots_ok: depotsOk,
    depots_mislukt: mislukt.length ? mislukt : null,
    rijen_gelezen: rijenTotaal,
    video_paths: videoPaths.length ? videoPaths : null,
  })
  if (mislukt.length) {
    console.warn(`Ritmonitor: gedeeltelijk gesynchroniseerd — overgeslagen: ${mislukt.map(m => m.depot).join(', ')}`)
  } else {
    console.log('Ritmonitor: alle depots gesynchroniseerd')
  }
}

// ---- Entrypoint -------------------------------------------------

const runOnce = process.argv.includes('--once') || process.env.RUN_ONCE === 'true'

if (runOnce) {
  syncRitmonitor().catch(err => { console.error(err); process.exit(1) })
} else {
  // Optionele eigen cron (naast/zonder Supabase pg_cron): zet MONITOR_CRON.
  if (process.env.MONITOR_CRON) {
    cron.schedule(process.env.MONITOR_CRON, () => {
      syncRitmonitor().catch(err => console.error(err))
    }, { timezone: CONFIG.timezone })
  }

  let bezig = false
  const port = Number(process.env.MONITOR_PORT || 3002)
  const workerSecret = process.env.WORKER_SECRET

  http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'POST' && req.url === '/sync-monitor') {
      if (workerSecret && req.headers['x-worker-secret'] !== workerSecret) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Ongeldige secret' })); return
      }
      if (bezig) { res.writeHead(409); res.end(JSON.stringify({ error: 'Monitor al bezig' })); return }
      bezig = true
      syncRitmonitor().catch(err => console.error(err)).finally(() => { bezig = false })
      res.writeHead(200); res.end(JSON.stringify({ success: true }))

    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, bezig }))

    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Niet gevonden' }))
    }
  }).listen(port, () => {
    console.log(`Ritmonitor-worker actief op poort ${port}. Endpoint: POST /sync-monitor`)
  })
}
