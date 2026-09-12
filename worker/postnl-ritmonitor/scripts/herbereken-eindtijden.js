// Herberekent postnl_eind_werktijd door alle polls uit ritmonitor_log opnieuw af te
// spelen met de huidige regel (src/eindtijd.js: de laatste registratie van de dag).
// Gebruikt op 2026-09-12, bewaard voor een volgende keer dat de regel verandert.
//
// Leest geen database en schrijft er niet naar: invoer zijn JSON-exports (output van
// `supabase db query`), uitvoer is SQL die je zelf controleert en draait.
//
//   node scripts/herbereken-eindtijden.js <log.json> <ritten.json> <uitvoermap> [ritten-origineel.json]
//
// log.json:    select datum, depot, ritnummer, created_at, stops_totaal, stops_te_doen,
//              laatste_actie, actie from ritmonitor_log where ... order by created_at
// ritten.json: select id, datum, depot, ritnummer, status, postnl_start_werktijd,
//              postnl_eind_werktijd from ritten where ...   (de HUIDIGE stand)
// ritten-origineel.json (optioneel): dezelfde export van vóór eerdere correcties, voor
//              de controle hieronder. Zonder dit bestand wordt ritten.json gebruikt.
//
// Controle op de naspeling: het script speelt elke rit óók na met de regels van vóór
// 2026-09-12 en rapporteert hoeveel daarvan exact de toen opgeslagen eindtijd opleveren.
// Dat bewijst dat de naspeling de worker getrouw nadoet. Het is geen filter: alleen de
// worker schrijft postnl_eind_werktijd (gecontroleerd 2026-09-12: geen app-code of
// databasefunctie doet dat), dus de pollgeschiedenis is de volledige bron.
//
// De update-SQL controleert per rit of de waarde sinds de export niet veranderd is
// (de worker draait door), en slaat hem anders over.

import fs from 'node:fs'
import path from 'node:path'
import { nlTijdstipNaarIso, nieuweEindtijd } from '../src/eindtijd.js'

const [logPad, rittenPad, uitMap, origineelPad] = process.argv.slice(2)
if (!logPad || !rittenPad || !uitMap) {
  console.error('Gebruik: node scripts/herbereken-eindtijden.js <log.json> <ritten.json> <uitvoermap> [ritten-origineel.json]')
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

// Oude regels: eindtijd = laatst gelezen actie, maar alleen zolang status niet 'gereden'
// en pas vanaf de poll ná de start. (Het oude verdwenen-pad met zijn terugval op
// "laatst gezien" wordt niet nagedaan — dat verklaart de paar ritten die niet kloppen.)
function speelNaOud(datum, startMs, polls) {
  const st = { status: null, teDoen: null, eind: null }
  const startIdx = polls.findIndex(p => p.actie === 'start-gezet')
  polls.forEach((p, i) => {
    const nuMs = ts(p.created_at)
    if (p.actie === 'verdwenen-afgerond') { st.status = 'gereden'; return }
    const startBekend = startMs != null && (startIdx >= 0 ? i > startIdx : startMs < nuMs - 60000)
    if (startBekend && st.status !== 'gereden') {
      const eind = oudeNlTijdstipNaarIso(datum, p.laatste_actie, nuMs)
      if (eind) st.eind = eind
    }
    const bevestigdNul = p.stops_te_doen === 0 && st.teDoen === 0
    if (p.stops_te_doen != null) st.status = bevestigdNul ? 'gereden' : 'bezig'
    st.teDoen = p.stops_te_doen
  })
  return st.eind
}

// Huidige regel: vanaf de poll waarop de rit start, het maximum van alle registraties.
function speelNa(datum, startMs, polls) {
  let eind = null
  const startIdx = polls.findIndex(p => p.actie === 'start-gezet')
  polls.forEach((p, i) => {
    const nuMs = ts(p.created_at)
    const gestart = p.actie === 'verdwenen-afgerond' ||
      (startIdx >= 0 ? i >= startIdx : startMs != null && startMs <= nuMs + 60000)
    const nieuw = nieuweEindtijd({ gestart, huidigeEindIso: eind, laatsteActieIso: nlTijdstipNaarIso(datum, p.laatste_actie, nuMs) })
    if (nieuw) eind = nieuw
  })
  return eind
}

const groepeer = rijen => {
  const m = new Map()
  for (const r of rijen) {
    const k = sleutel(r.datum, r.depot, r.ritnummer)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}
const pollsPerRit = groepeer(leesRijen(logPad))
const rittenPerSleutel = groepeer(leesRijen(rittenPad))
const origineel = new Map(leesRijen(origineelPad || rittenPad).map(r => [r.id, r.postnl_eind_werktijd]))

const tel = { ritten: 0, dubbeleRit: 0, dubbeleGridRegel: 0, geenPolls: 0, controleGeteld: 0, controleKlopt: 0, ongewijzigd: 0, later: 0, eerder: 0, eersteEindtijd: 0 }
const wijzigingen = []
const controleAfwijkend = []

for (const [k, ritten] of rittenPerSleutel) {
  const rit = ritten[0]
  tel.ritten++
  if (ritten.length > 1) { tel.dubbeleRit++; continue }
  const polls = (pollsPerRit.get(k) || []).slice().sort((a, b) => ts(a.created_at) - ts(b.created_at))
  if (!polls.length) { tel.geenPolls++; continue }
  // Twee grid-regels met hetzelfde ritnummer (bv. 08-09 rit 224, HD + GB) overschrijven
  // elkaar binnen één run — niet eenduidig na te spelen, dus overslaan.
  const momenten = polls.map(p => p.created_at)
  if (new Set(momenten).size !== momenten.length) { tel.dubbeleGridRegel++; continue }

  const startMs = ts(rit.postnl_start_werktijd)
  const origMs = ts(origineel.get(rit.id))
  if (origMs != null) {
    tel.controleGeteld++
    const oud = ts(speelNaOud(rit.datum, startMs, polls))
    if (oud != null && Math.abs(oud - origMs) < 60000) tel.controleKlopt++
    else controleAfwijkend.push(`${rit.datum} ${rit.depot} ${rit.ritnummer}`)
  }

  const nieuw = ts(speelNa(rit.datum, startMs, polls))
  const dbMs = ts(rit.postnl_eind_werktijd)
  if (nieuw == null) { tel.ongewijzigd++; continue }            // geen registratie: laten staan
  if (dbMs != null && Math.abs(nieuw - dbMs) < 60000) { tel.ongewijzigd++; continue }

  if (dbMs == null) tel.eersteEindtijd++
  else nieuw > dbMs ? tel.later++ : tel.eerder++
  wijzigingen.push({
    id: rit.id, datum: rit.datum, depot: rit.depot, ritnummer: rit.ritnummer,
    oud: rit.postnl_eind_werktijd ?? null, nieuw: iso(nieuw),
    minuten: dbMs == null ? null : Math.round((nieuw - dbMs) / 60000),
  })
}

// ── Uitvoer ──────────────────────────────────────────────────────
fs.mkdirSync(uitMap, { recursive: true })
const lit = v => (v == null ? 'null::timestamptz' : `'${v}'::timestamptz`)
const updateSql = (van, naar, titel) => `-- ${titel}
-- Gegenereerd door postnl-scrapers/worker/postnl-ritmonitor/scripts/herbereken-eindtijden.js
-- ${wijzigingen.length} ritten. Werkt alleen rijen bij die sinds de export niet veranderd zijn.
begin;
update public.ritten r
set postnl_eind_werktijd = v.naar
from (values
${wijzigingen.map(w => `  ('${w.id}', ${lit(w[van])}, ${lit(w[naar])})`).join(',\n')}
) as v(id, van, naar)
where r.id = v.id::uuid
  and r.postnl_eind_werktijd is not distinct from v.van;
commit;
`
fs.writeFileSync(path.join(uitMap, 'backfill.sql'), updateSql('oud', 'nieuw', 'Eindtijd = laatste registratie van de dag (regel van 2026-09-12)'))
fs.writeFileSync(path.join(uitMap, 'rollback.sql'), updateSql('nieuw', 'oud', 'Terugdraaien: zet de eindtijden van vóór deze herberekening terug'))
fs.writeFileSync(path.join(uitMap, 'wijzigingen.json'), JSON.stringify(wijzigingen, null, 2))

const verschil = wijzigingen.filter(w => w.minuten != null).map(w => w.minuten)
const gem = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
console.log(JSON.stringify({
  ...tel,
  controle: `${tel.controleKlopt} van ${tel.controleGeteld} oude eindtijden exact nagespeeld`,
  controle_afwijkend: controleAfwijkend,
  gemiddeld_later_min: gem(verschil.filter(m => m > 0)),
  max_later_min: Math.max(0, ...verschil),
  gemiddeld_eerder_min: gem(verschil.filter(m => m < 0)),
  min_eerder_min: Math.min(0, ...verschil),
}, null, 2))
