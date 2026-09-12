import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nlTijdstipNaarIso, nieuweEindtijd } from '../src/eindtijd.js'

// Tijden in de tests zijn NL-lokaal; september = CEST (UTC+2).
const nl = (datum, hhmm) => new Date(`${datum}T${hhmm}:00+02:00`).toISOString()
const ms = iso => Date.parse(iso)
const D = '2026-09-11'

test('nlTijdstipNaarIso: tekst is NL-lokale tijd', () => {
  assert.equal(nlTijdstipNaarIso(D, '16:55', ms(nl(D, '17:00'))), nl(D, '16:55'))
})

test('nlTijdstipNaarIso: een oude actie wordt niet meer als UTC gelezen (29-08 rit 715)', () => {
  // Oud gedrag: "17:50" om 19:57 uitgelezen → als UTC = 19:50 NL, 2 uur te laat.
  assert.equal(nlTijdstipNaarIso('2026-08-29', '17:50', ms(nl('2026-08-29', '19:57'))), nl('2026-08-29', '17:50'))
})

test('nlTijdstipNaarIso: wintertijd rekent met UTC+1', () => {
  assert.equal(nlTijdstipNaarIso('2026-11-10', '10:00', Date.parse('2026-11-10T12:00:00Z')), '2026-11-10T09:00:00.000Z')
})

test('nlTijdstipNaarIso: tijd in de toekomst wordt verworpen; klein klokverschil ongewijzigd overgenomen', () => {
  const nu = ms(nl(D, '16:00'))
  assert.equal(nlTijdstipNaarIso(D, '16:30', nu), null)
  assert.equal(nlTijdstipNaarIso(D, '16:02', nu), nl(D, '16:02'))
})

test('nlTijdstipNaarIso: tijd van gisteren vóór de start van de rit valt af (05-09 rit 220)', () => {
  // Om 07:15 toonde de kolom nog "16:36" van de vorige dag.
  assert.equal(nlTijdstipNaarIso('2026-09-05', '16:36', ms(nl('2026-09-05', '07:15'))), null)
})

test('nlTijdstipNaarIso: onparseerbare tekst → null', () => {
  assert.equal(nlTijdstipNaarIso(D, '', Date.now()), null)
  assert.equal(nlTijdstipNaarIso(D, null, Date.now()), null)
  assert.equal(nlTijdstipNaarIso(D, 'onbekend', Date.now()), null)
})

test('nieuweEindtijd: de laatste registratie is de eindtijd, ook na 0 stops (Emrullah 11-09)', () => {
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: nl(D, '16:55'), laatsteActieIso: nl(D, '18:21') }), nl(D, '18:21'))
})

test('nieuweEindtijd: ook uren stilstand ervoor maakt niet uit (09-09 Den Hoorn 223)', () => {
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: nl(D, '15:28'), laatsteActieIso: nl(D, '21:56') }), nl(D, '21:56'))
})

test('nieuweEindtijd: gaat nooit terug in de tijd, en schrijft niet bij gelijke tijd', () => {
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: nl(D, '18:21'), laatsteActieIso: nl(D, '16:55') }), null)
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: nl(D, '18:21'), laatsteActieIso: nl(D, '18:21') }), null)
  // Supabase geeft '+00:00' terug, toISOString() 'Z' — dat is dezelfde tijd.
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: '2026-09-11T16:21:00+00:00', laatsteActieIso: nl(D, '18:21') }), null)
})

test('nieuweEindtijd: eerste registratie zet de eindtijd als er nog geen is', () => {
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: null, laatsteActieIso: nl(D, '09:10') }), nl(D, '09:10'))
})

test('nieuweEindtijd: niets vóór de start van de rit, en niets zonder registratie', () => {
  assert.equal(nieuweEindtijd({ gestart: false, huidigeEindIso: null, laatsteActieIso: nl(D, '09:10') }), null)
  assert.equal(nieuweEindtijd({ gestart: true, huidigeEindIso: nl(D, '09:10'), laatsteActieIso: null }), null)
})
