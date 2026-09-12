// Herberekent postnl_eind_werktijd van al gereden ritten door alle polls uit
// ritmonitor_log opnieuw af te spelen met de huidige regels (src/eindtijd.js).
// Eenmalig gebruikt op 2026-09-12 (eindtijd bevroor na 0 stops + 2-uur-tijdzonebug),
// bewaard voor een volgende keer dat de regels veranderen.
//
// Leest geen database en schrijft er niet naar: invoer zijn twee JSON-exports
// (output van `supabase db query`), uitvoer is SQL die je zelf controleert en draait.
//
//   node scripts/herbereken-eindtijden.js <log.json> <ritten.json> <uitvoermap>
//
// log.json:    select datum, depot, ritnummer, created_at, stops_totaal, stops_te_doen,
//              laatste_actie, actie from ritmonitor_log where ... order by created_at
// ritten.json: select id, datum, depot, ritnummer, status, postnl_start_werktijd,
//              postnl_eind_werktijd from ritten where ...
//
// Veiligheidsnet: het script speelt elke rit óók na met de OUDE regels. Alleen ritten
// waarvan die naspeling exact de eindtijd oplevert die nu in de database staat, worden
// bijgewerkt — anders heeft iets anders die waarde gezet (handmatig, het
// verdwenen-uit-grid-pad) en blijft hij staan. De update-SQL controleert bovendien of de
// waarde sinds de export niet veranderd is.

import fs from 'node:fs'
import path from 'node:path'
import { nlTijdstipNaarIso, nieuweEindtijd } from '../src/eindtijd.js'

const [logPad, rittenPad, uitMap] = process.argv.slice(2)
if (!logPad || !rittenPad || !uitMap) {
  console.error('Gebruik: node scripts/herbereken-eindtijden.js <log.json> <ritten.json> <uitvoermap>')
  process.exit(1)
}

const leesRijen = pad => {
  const tekst = fs.readFileSync(pad, 'utf8').replace(/^﻿/, '')
  const json = JSON.parse(tekst)
  return Array.isArray(json) ? json : json.rows
}

// Postgres-tekst ("2026-09-11 14:55:00.123+00") → epoch-ms.
function ts(waarde) {
  if (!waarde) return null
  const s = String(waarde).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}
const iso = ms => (ms == null ? null : new Date(ms).toISOString())
const sleutel = (datum, depot, ritnummer) => `${datum}|${depot}|${parseInt(ritnummer, 10)}`

// Oude tijdzone-heuristiek (tot 2026-09-12): beide interpretaties, meest recente wint.
function oudeNlTijdstipNaarIso(datum, tekst, nuMs) {
  const m = String(tekst || '').match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const alsUtc = Date.parse(`${datum}T${m[1].padStart(2, '0')}:${m[2]}:00Z`)
  if (Number.isNaN(alsUtc)) return null
  const nl = Date.parse(nlTijdstipNaarIso(datum, tekst, Number.MAX_SAFE_INTEGER))
  const kandidaten = [alsUtc, nl].filter(x => x <= nuMs).sort((a, b) => b - a)
  return kandidaten.length ? iso(kandidaten[0]) : null
}

function speelNa(datum, startMs, polls, regels) {
  const st = { status: null, teDoen: null, eind: null, opgehaald: null }
  // Starttijd geldt vanaf de poll ná 'start-gezet' (op die poll zelf was hij nog leeg).
  const startIdx = polls.findIndex(p => p.actie === 'start-gezet')

  polls.forEach((p, i) => {
    const nuMs = ts(p.created_at)
    if (p.actie === 'verdwenen-afgerond') { st.status = 'gereden'; return }

    const startBekend = startMs != null && (startIdx >= 0 ? i > startIdx : startMs < nuMs - 60000)
    if (regels === 'nieuw') {
      const eind = nieuweEindtijd({
        bestaand: {
          postnl_start_werktijd: startBekend ? iso(startMs) : null,
          status: st.status,
          postnl_stops_te_doen: st.teDoen,
          postnl_eind_werktijd: st.eind,
          postnl_monitor_opgehaald: st.opgehaald,
        },
        stopsTeDoen: p.stops_te_doen,
        laatsteActieIso: nlTijdstipNaarIso(datum, p.laatste_actie, nuMs),
      })
      if (eind) st.eind = eind
    } else if (startBekend && st.status !== 'gereden') {
      const eind = oudeNlTijdstipNaarIso(datum, p.laatste_actie, nuMs)
      if (eind) st.eind = eind
    }

    const bevestigdNul = p.stops_te_doen === 0 && st.teDoen === 0
    if (p.stops_te_doen != null) st.status = bevestigdNul ? 'gereden' : 'bezig'
    st.teDoen = p.stops_te_doen
    st.opgehaald = iso(nuMs)
  })
  return st.eind
}

// ── Invoer groeperen ─────────────────────────────────────────────
const pollsPerRit = new Map()
for (const p of leesRijen(logPad)) {
  const k = sleutel(p.datum, p.depot, p.ritnummer)
  if (!pollsPerRit.has(k)) pollsPerRit.set(k, [])
  pollsPerRit.get(k).push(p)
}
const rittenPerSleutel = new Map()
for (const r of leesRijen(rittenPad)) {
  const k = sleutel(r.datum, r.depot, r.ritnummer)
  if (!rittenPerSleutel.has(k)) rittenPerSleutel.set(k, [])
  rittenPerSleutel.get(k).push(r)
}

// ── Naspelen ─────────────────────────────────────────────────────
const tel = { ritten: 0, dubbeleRit: 0, dubbeleGridRegel: 0, geenPolls: 0, oudKloptNiet: 0, ongewijzigd: 0, later: 0, eerder: 0 }
const wijzigingen = []

for (const [k, ritten] of rittenPerSleutel) {
  const rit = ritten[0]
  if (!rit.postnl_eind_werktijd) continue
  tel.ritten++
  if (ritten.length > 1) { tel.dubbeleRit++; continue }
  const polls = (pollsPerRit.get(k) || []).slice().sort((a, b) => ts(a.created_at) - ts(b.created_at))
  if (!polls.length) { tel.geenPolls++; continue }
  // Twee grid-regels met hetzelfde ritnummer (bv. 08-09 rit 224, HD + GB) overschrijven
  // elkaar binnen één run — niet eenduidig na te spelen, dus overslaan.
  const momenten = polls.map(p => p.created_at)
  if (new Set(momenten).size !== momenten.length) { tel.dubbeleGridRegel++; continue }

  const dbMs = ts(rit.postnl_eind_werktijd)
  const startMs = ts(rit.postnl_start_werktijd)
  const oud = ts(speelNa(rit.datum, startMs, polls, 'oud'))
  if (oud == null || Math.abs(oud - dbMs) >= 60000) { tel.oudKloptNiet++; continue }

  const nieuw = ts(speelNa(rit.datum, startMs, polls, 'nieuw'))
  if (nieuw == null || Math.abs(nieuw - dbMs) < 60000) { tel.ongewijzigd++; continue }

  nieuw > dbMs ? tel.later++ : tel.eerder++
  wijzigingen.push({ id: rit.id, datum: rit.datum, depot: rit.depot, ritnummer: rit.ritnummer, oud: rit.postnl_eind_werktijd, nieuw: iso(nieuw), minuten: Math.round((nieuw - dbMs) / 60000) })
}

// ── Uitvoer ──────────────────────────────────────────────────────
fs.mkdirSync(uitMap, { recursive: true })
const values = (van, naar) => wijzigingen
  .map(w => `  ('${w.id}', '${w[van]}'::timestamptz, '${w[naar]}'::timestamptz)`)
  .join(',\n')
const updateSql = (van, naar, titel) => `-- ${titel}
-- Gegenereerd door postnl-scrapers/worker/postnl-ritmonitor/scripts/herbereken-eindtijden.js
-- ${wijzigingen.length} ritten. Werkt alleen rijen bij die sinds de export niet veranderd zijn.
begin;
update public.ritten r
set postnl_eind_werktijd = v.naar
from (values
${values(van, naar)}
) as v(id, van, naar)
where r.id = v.id::uuid
  and r.postnl_eind_werktijd = v.van;
commit;
`
fs.writeFileSync(path.join(uitMap, 'backfill.sql'), updateSql('oud', 'nieuw', 'Eindtijden herberekend met de regels van 2026-09-12'))
fs.writeFileSync(path.join(uitMap, 'rollback.sql'), updateSql('nieuw', 'oud', 'Terugdraaien: zet de eindtijden van vóór de herberekening terug'))
fs.writeFileSync(path.join(uitMap, 'wijzigingen.json'), JSON.stringify(wijzigingen, null, 2))

const gem = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
const later = wijzigingen.filter(w => w.minuten > 0).map(w => w.minuten)
const eerder = wijzigingen.filter(w => w.minuten < 0).map(w => w.minuten)
console.log(JSON.stringify({
  ...tel,
  naspeling_oude_regels_klopt: `${tel.ritten - tel.dubbeleRit - tel.dubbeleGridRegel - tel.geenPolls - tel.oudKloptNiet} van ${tel.ritten - tel.dubbeleRit - tel.dubbeleGridRegel - tel.geenPolls}`,
  gemiddeld_later_min: gem(later), max_later_min: Math.max(0, ...later),
  gemiddeld_eerder_min: gem(eerder), eerder_verdeling: eerder.reduce((acc, m) => ({ ...acc, [m]: (acc[m] || 0) + 1 }), {}),
}, null, 2))
