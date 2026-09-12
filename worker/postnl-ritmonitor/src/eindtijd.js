// Beslislogica voor postnl_eind_werktijd — bewust los van Playwright/Supabase,
// zodat hij testbaar is (test/eindtijd.test.js) en het herstelscript
// (scripts/herbereken-eindtijden.js) exact dezelfde regels gebruikt als de worker.
// Zie POSTNL_RITMONITOR.md § Werkuren voor de achtergrond.

// Hoe lang een rit met 0 stops te doen zonder nieuwe actie in de Ritmonitor mag
// staan voordat een latere actie niet meer als werk van de chauffeur telt.
// Na 0 stops doet de chauffeur vaak nog van alles (ophaalstops en retouren tellen
// niet mee in "Stops te doen", daarna terugrijden en afmelden op het depot) —
// stappen van 10-60 min. Een actie ná lange stilstand is in de praktijk een
// depot-/systeemactie die vaak op dezelfde minuut bij meerdere ritten tegelijk
// valt (bv. 09-09 Den Hoorn: 218 en 223 allebei om 21:56, 5-6 uur na hun laatste
// levering). Gemeten over 26-08 t/m 11-09: 94% van de stappen na 0 is ≤ 60 min.
export const NAWERK_MAX_STILSTAND_MIN = 90

// Hoeveel een "laatste actie" ná het scrape-moment mag liggen voordat hij als
// onmogelijk wordt verworpen — vangt een klein klokverschil met PostNL's server.
const TOEKOMST_TOLERANTIE_MS = 5 * 60000

// Zet een "HH:MM"-wandkloktijd uit de Ritmonitor-kolom "Tijdstip laatste actie"
// om naar een ISO-timestamp. De datum is altijd de scrape-dag.
//
// De tekst is altijd NL-lokale tijd: de browser-context draait met
// timezoneId 'Europe/Amsterdam' (zie openDepotSessie in index.js), en Mendix rendert
// de tijd client-side in die tijdzone. Vóór die instelling (tot 25-08) kwam de tekst
// soms in UTC, en daarom rekende deze functie beide interpretaties uit en koos de
// meest recente. Dat gaf sindsdien alleen nog fouten: een "laatste actie" die meer
// dan 2 uur oud was bij het uitlezen werd als UTC gelezen en kwam precies 2 uur te
// laat uit (bv. 29-08 rit 715: 17:50 opgeslagen als 19:50). Gemeten over 20.500
// polls sinds 26-08: nooit een tekst die op UTC wees.
//
// Retourneert null bij onparseerbare tekst of een tijd die (buiten de tolerantie)
// in de toekomst ligt.
export function nlTijdstipNaarIso(datum, tekst, nuMs = Date.now(), timeZone = 'Europe/Amsterdam') {
  const m = String(tekst || '').match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const alsUtc = new Date(`${datum}T${m[1].padStart(2, '0')}:${m[2]}:00Z`)
  if (Number.isNaN(alsUtc.getTime())) return null

  const offsetNaam = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(alsUtc).find(p => p.type === 'timeZoneName')?.value || ''
  const om = offsetNaam.match(/([+-])(\d{2}):(\d{2})/)
  const offsetMin = om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : 0
  const ms = alsUtc.getTime() - offsetMin * 60000

  if (ms > nuMs + TOEKOMST_TOLERANTIE_MS) return null
  return new Date(Math.min(ms, nuMs)).toISOString()
}

// Bepaalt of deze poll postnl_eind_werktijd moet bijwerken. Retourneert de nieuwe
// ISO-waarde, of null als de eindtijd moet blijven staan.
//
//   bestaand         — de ritten-rij zoals vóór deze poll (postnl_start_werktijd,
//                      postnl_eind_werktijd, postnl_stops_te_doen, status,
//                      postnl_monitor_opgehaald = moment van de vorige poll)
//   stopsTeDoen      — "Stops te doen" uit deze poll (null = onbekend)
//   laatsteActieIso  — "Tijdstip laatste actie" uit deze poll, al via nlTijdstipNaarIso
//
// Regels:
// 1. Pas vanaf het moment dat de rit gestart is (postnl_start_werktijd gezet).
// 2. Met open stops volgt de eindtijd altijd de laatste actie — ook als de rit al op
//    'gereden' stond (PostNL voegt soms stops toe aan een rit die al op 0 stond).
// 3. De poll waarop de teller naar 0 gaat: altijd volgen (dat is de laatste levering).
// 4. Daarna, met de teller op 0: blijven volgen, want de chauffeur is vaak nog bezig.
//    Tot 2026-09-12 bevroor de eindtijd hier (status 'gereden' blokkeerde elke update),
//    waardoor bij 37% van de ritten de eindtijd te vroeg stond, gemiddeld een uur. Wel
//    met één grens: stond de rit bij de vorige poll al langer dan
//    NAWERK_MAX_STILSTAND_MIN zonder actie, dan telt een latere actie niet meer.
//    De stilstand wordt gemeten tot de vorige poll (wat we zeker weten), niet tot de
//    nieuwe actie — zo telt een gat in de polling zelf niet als stilstand.
export function nieuweEindtijd({ bestaand, stopsTeDoen, laatsteActieIso }) {
  if (!bestaand?.postnl_start_werktijd || !laatsteActieIso) return null

  const nogOpen = stopsTeDoen != null ? stopsTeDoen > 0 : bestaand.status !== 'gereden'
  if (nogOpen) return laatsteActieIso

  const vorigeTeDoen = bestaand.postnl_stops_te_doen
  if (vorigeTeDoen == null || vorigeTeDoen > 0) return laatsteActieIso

  const huidigMs = bestaand.postnl_eind_werktijd ? Date.parse(bestaand.postnl_eind_werktijd) : NaN
  if (Number.isNaN(huidigMs)) return laatsteActieIso

  const actieMs = Date.parse(laatsteActieIso)
  if (!(actieMs > huidigMs)) return null

  const vorigePollMs = bestaand.postnl_monitor_opgehaald ? Date.parse(bestaand.postnl_monitor_opgehaald) : NaN
  const stilstandMin = ((Number.isNaN(vorigePollMs) ? actieMs : vorigePollMs) - huidigMs) / 60000
  if (stilstandMin > NAWERK_MAX_STILSTAND_MIN) return null

  return laatsteActieIso
}
