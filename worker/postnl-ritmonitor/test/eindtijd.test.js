import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nlTijdstipNaarIso, nieuweEindtijd, NAWERK_MAX_STILSTAND_MIN } from '../src/eindtijd.js'

// Tijden in de tests zijn NL-lokaal; september = CEST (UTC+2).
const nl = (datum, hhmm) => new Date(`${datum}T${hhmm}:00+02:00`).toISOString()
const ms = iso => Date.parse(iso)

test('nlTijdstipNaarIso: tekst is NL-lokale tijd', () => {
  assert.equal(nlTijdstipNaarIso('2026-09-11', '16:55', ms(nl('2026-09-11', '17:00'))), nl('2026-09-11', '16:55'))
})

test('nlTijdstipNaarIso: een oude actie wordt niet meer als UTC gelezen (29-08 rit 715)', () => {
  // Oud gedrag: "17:50" om 19:57 uitgelezen → als UTC = 19:50 NL, 2 uur te laat.
  assert.equal(nlTijdstipNaarIso('2026-08-29', '17:50', ms(nl('2026-08-29', '19:57'))), nl('2026-08-29', '17:50'))
})

test('nlTijdstipNaarIso: wintertijd rekent met UTC+1', () => {
  const nu = Date.parse('2026-11-10T12:00:00Z')
  assert.equal(nlTijdstipNaarIso('2026-11-10', '10:00', nu), '2026-11-10T09:00:00.000Z')
})

test('nlTijdstipNaarIso: tijd in de toekomst wordt verworpen, klein klokverschil niet', () => {
  const nu = ms(nl('2026-09-11', '16:00'))
  assert.equal(nlTijdstipNaarIso('2026-09-11', '16:30', nu), null)
  assert.equal(nlTijdstipNaarIso('2026-09-11', '16:02', nu), nl('2026-09-11', '16:00'))
})

test('nlTijdstipNaarIso: onparseerbare tekst → null', () => {
  assert.equal(nlTijdstipNaarIso('2026-09-11', '', Date.now()), null)
  assert.equal(nlTijdstipNaarIso('2026-09-11', null, Date.now()), null)
  assert.equal(nlTijdstipNaarIso('2026-09-11', 'onbekend', Date.now()), null)
})

const D = '2026-09-11'
const basis = {
  postnl_start_werktijd: nl(D, '08:57'),
  status: 'gereden',
  postnl_stops_te_doen: 0,
  postnl_eind_werktijd: nl(D, '16:55'),
}

test('nieuweEindtijd: na 0 stops loopt de eindtijd mee met het nawerk (Emrullah 11-09)', () => {
  // 16:49 teller op 0, laatste levering 16:55, rit blijft in de grid; om 18:21 de
  // laatste actie (afmelden). Vorige poll 18:14 → 79 min stilstand, binnen de grens.
  const eind = nieuweEindtijd({
    bestaand: { ...basis, postnl_monitor_opgehaald: nl(D, '18:14') },
    stopsTeDoen: 0,
    laatsteActieIso: nl(D, '18:21'),
  })
  assert.equal(eind, nl(D, '18:21'))
})

test('nieuweEindtijd: depot-actie na lange stilstand telt niet (09-09 Den Hoorn 223)', () => {
  const eind = nieuweEindtijd({
    bestaand: { ...basis, postnl_eind_werktijd: nl(D, '15:28'), postnl_monitor_opgehaald: nl(D, '21:49') },
    stopsTeDoen: 0,
    laatsteActieIso: nl(D, '21:56'),
  })
  assert.equal(eind, null)
})

test('nieuweEindtijd: grens is inclusief NAWERK_MAX_STILSTAND_MIN', () => {
  const vorigePoll = new Date(ms(basis.postnl_eind_werktijd) + NAWERK_MAX_STILSTAND_MIN * 60000).toISOString()
  const op = nieuweEindtijd({ bestaand: { ...basis, postnl_monitor_opgehaald: vorigePoll }, stopsTeDoen: 0, laatsteActieIso: nl(D, '18:30') })
  assert.equal(op, nl(D, '18:30'))
  const erover = new Date(ms(vorigePoll) + 60000).toISOString()
  assert.equal(nieuweEindtijd({ bestaand: { ...basis, postnl_monitor_opgehaald: erover }, stopsTeDoen: 0, laatsteActieIso: nl(D, '18:30') }), null)
})

test('nieuweEindtijd: een gat in de polling telt niet als stilstand', () => {
  // Laatste poll vóór het gat om 17:00 (5 min na de laatste actie), daarna pas om 19:35.
  const eind = nieuweEindtijd({
    bestaand: { ...basis, postnl_monitor_opgehaald: nl(D, '17:00') },
    stopsTeDoen: 0,
    laatsteActieIso: nl(D, '19:30'),
  })
  assert.equal(eind, nl(D, '19:30'))
})

test('nieuweEindtijd: met open stops altijd volgen, ook als de rit al op gereden stond', () => {
  // 04-09 Waddinxveen 337: om 12:08 op gereden, om 15:57 42 nieuwe stops erbij.
  const eind = nieuweEindtijd({
    bestaand: { ...basis, postnl_eind_werktijd: nl(D, '11:56'), postnl_monitor_opgehaald: nl(D, '15:50') },
    stopsTeDoen: 42,
    laatsteActieIso: nl(D, '15:59'),
  })
  assert.equal(eind, nl(D, '15:59'))
})

test('nieuweEindtijd: de poll waarop de teller naar 0 gaat telt altijd', () => {
  const eind = nieuweEindtijd({
    bestaand: { ...basis, status: 'bezig', postnl_stops_te_doen: 3, postnl_eind_werktijd: nl(D, '12:00'), postnl_monitor_opgehaald: nl(D, '12:05') },
    stopsTeDoen: 0,
    laatsteActieIso: nl(D, '15:00'),
  })
  assert.equal(eind, nl(D, '15:00'))
})

test('nieuweEindtijd: niets doen zonder start, zonder actie, of als de actie niet later is', () => {
  assert.equal(nieuweEindtijd({ bestaand: { ...basis, postnl_start_werktijd: null }, stopsTeDoen: 5, laatsteActieIso: nl(D, '10:00') }), null)
  assert.equal(nieuweEindtijd({ bestaand: basis, stopsTeDoen: 5, laatsteActieIso: null }), null)
  assert.equal(nieuweEindtijd({ bestaand: { ...basis, postnl_monitor_opgehaald: nl(D, '17:00') }, stopsTeDoen: 0, laatsteActieIso: nl(D, '16:55') }), null)
})

test('nieuweEindtijd: onbekende teller volgt de oude regel (alleen zolang niet gereden)', () => {
  assert.equal(nieuweEindtijd({ bestaand: { ...basis, status: 'bezig' }, stopsTeDoen: null, laatsteActieIso: nl(D, '17:10') }), nl(D, '17:10'))
})
