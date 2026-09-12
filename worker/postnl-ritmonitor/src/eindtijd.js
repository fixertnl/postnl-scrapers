// Beslislogica voor postnl_eind_werktijd — bewust los van Playwright/Supabase,
// zodat hij testbaar is (test/eindtijd.test.js) en het herstelscript
// (scripts/herbereken-eindtijden.js) exact dezelfde regels gebruikt als de worker.
// Zie POSTNL_RITMONITOR.md § Werkuren voor de achtergrond.
//
// DE REGEL (besluit 2026-09-12, bepaalt de uitbetaling): de eindtijd is het laatste
// "Tijdstip laatste actie" dat PostNL die dag voor de rit registreerde. Niets anders:
// geen uitzondering voor "0 stops te doen", geen grens na stilstand, en nooit een
// tijd die we zelf afleiden (zoals het moment waarop we de rit het laatst zagen).

// Hoeveel een "laatste actie" ná het scrape-moment mag liggen voordat hij als
// onmogelijk wordt verworpen — vangt een klein klokverschil met PostNL's server.
// Binnen de tolerantie wordt de registratie ongewijzigd overgenomen (niet
// afgeknipt op ons scrape-moment): PostNL's tijd is de registratie, de onze niet.
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
// De toekomst-check is ook de bescherming tegen een tijd van de VORIGE dag: vóór een
// rit start toont de kolom soms nog die tijd (bv. om 07:15 al "16:36"). Op de
// scrape-dag geplakt ligt die in de toekomst en valt hij af. Een tijd van gisteren die
// vroeger op de dag lag dan het scrape-moment komt er wél door, maar telt alleen mee
// als de rit al gestart is — en dan is er altijd al een latere echte registratie.
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
  return new Date(ms).toISOString()
}

// Bepaalt of deze poll postnl_eind_werktijd moet bijwerken. Retourneert de nieuwe
// ISO-waarde, of null als de eindtijd moet blijven staan.
//
//   gestart          — de rit is gestart (postnl_start_werktijd staat, of wordt deze
//                      poll gezet). Daarvóór kan de kolom nog een tijd van gisteren tonen.
//   huidigeEindIso   — postnl_eind_werktijd zoals die nu in de database staat
//   laatsteActieIso  — "Tijdstip laatste actie" uit deze poll, al via nlTijdstipNaarIso
//
// De eindtijd gaat alleen vooruit: het is het maximum van alle registraties. In de
// data (35.600 opeenvolgende polls, 26-08 t/m 12-09) liep een echte registratie nooit
// terug; alleen de tijd-van-gisteren hierboven deed dat.
export function nieuweEindtijd({ gestart, huidigeEindIso, laatsteActieIso }) {
  if (!gestart || !laatsteActieIso) return null
  const actieMs = Date.parse(laatsteActieIso)
  if (Number.isNaN(actieMs)) return null
  const huidigMs = huidigeEindIso ? Date.parse(huidigeEindIso) : NaN
  if (!Number.isNaN(huidigMs) && actieMs <= huidigMs) return null
  return new Date(actieMs).toISOString()
}
