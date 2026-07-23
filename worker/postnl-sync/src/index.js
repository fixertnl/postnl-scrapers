import 'dotenv/config'
import cron from 'node-cron'
import http from 'node:http'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { metProxy } from '../../postnl-shared/proxy.js'

const CONFIG = {
  cronTime: process.env.CRON_TIME || '0 23 * * *',
  timezone: process.env.TZ || 'Europe/Amsterdam',
  shifts: (process.env.POSTNL_SHIFTS || '01,02,03,04,05,06,07').split(',').map(s => s.trim()).filter(Boolean),
  headless: String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false',
  slowMo: Number(process.env.POSTNL_SLOWMO || 0),
  storageState: process.env.POSTNL_STORAGE_STATE || '.postnl-auth-state.json',
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

// Converts DD-MM-YYYY label to YYYY-MM-DD
function labelNaarDatum(label) {
  const [dag, maand, jaar] = label.split('-')
  if (!dag || !maand || !jaar) return null
  return `${jaar}-${maand.padStart(2, '0')}-${dag.padStart(2, '0')}`
}

async function loginPostnl(page, depot) {
  console.log(`[${depot.naam}] Login pagina URL:`, page.url())
  await page.locator('input[type="text"], input[type="email"]').first().waitFor({ timeout: 15000 })
  await page.locator('input[type="text"], input[type="email"]').first().fill(depot.username)
  await page.locator('input[type="password"]').first().fill(depot.password)
  await page.locator('button[data-trn-key="login.butlogin"]').click()
  try {
    await page.waitForURL('**pnl-oompd**', { timeout: 90000 })
  } catch {
    throw new Error(`Login redirect mislukt. URL na login: ${page.url()}`)
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  console.log(`[${depot.naam}] Ingelogd, URL:`, page.url())
}

class PageReloadError extends Error {
  constructor(shift) { super(`Pagina herlaadde tijdens shift ${shift}`) }
}

async function leesShift(page, shift, depotHostname) {
  function checkPagina() {
    if (!page.url().includes(depotHostname)) throw new PageReloadError(shift)
  }

  // Scope click to the shift grid — div.mx-datagrid-data-wrapper contains exactly the shift number
  const rij = page.locator('.mx-name-Shift_Grid_1 div.mx-datagrid-data-wrapper')
    .filter({ hasText: new RegExp(`^\\s*${shift}\\s*$`) }).first()
  try {
    await rij.waitFor({ state: 'visible', timeout: 8000 })
  } catch {
    checkPagina()
    console.log(`Shift ${shift}: niet beschikbaar op deze datum`)
    return []
  }

  await rij.click()
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  checkPagina()
  await page.waitForTimeout(1500)
  checkPagina()

  let rijen
  try {
    const result = await page.evaluate(() => {
      function cel(row, cls) {
        return row.querySelector(`td.${cls}`)?.getAttribute('title')?.trim() || ''
      }
      // th[title="Ritten"] is in the SHIFT GRID header (shows rit count per shift).
      // We need the rit DETAIL grid — exclude the shift grid's content divs.
      const shiftGrid = document.querySelector('.mx-name-Shift_Grid_1')
      const divs = Array.from(document.querySelectorAll('.mx-grid-content'))
        .filter(d => !shiftGrid || !shiftGrid.contains(d))
      const rows = divs.flatMap(d => Array.from(d.querySelectorAll('tbody tr[data-id]')))
      const mapped = rows.map(row => ({
        ritnaam:         cel(row, 'mx-name-column7'),
        chauffeur:       cel(row, 'mx-name-column8'),
        stops:           cel(row, 'mx-name-column11'),
        stuks:           cel(row, 'mx-name-column12'),
        volume:          cel(row, 'mx-name-column13'),
        brievenbusstops: cel(row, 'mx-name-column17'),
        gewicht:         cel(row, 'mx-name-column14'),
      }))
      const f = mapped[0]
      return {
        rows: mapped,
        debug: `${rows.length} rijen van ${divs.length} non-shift grids, eerste={ritnaam:"${f?.ritnaam}",stops:"${f?.stops}"}`,
      }
    })
    console.log(`[DEBUG shift ${shift}] ${result.debug}`)
    rijen = result.rows
  } catch (err) {
    if (err.message.includes('context')) throw new PageReloadError(shift)
    throw err
  }

  const resultaat = rijen
    .filter(r => r.ritnaam && /^\d{3,4}/.test(r.ritnaam) && toNumber(r.stops) !== null)
    .map(r => {
      const ritnummer = normaliseerRitnummer(r.ritnaam.match(/^\d+/)?.[0] || '')
      return {
        ritnaam:         r.ritnaam,
        ritnummer,
        chauffeur:       r.chauffeur || null,
        stops:           toNumber(r.stops),
        stuks:           toNumber(r.stuks),
        volume:          r.volume || null,
        brievenbusstops: toNumber(r.brievenbusstops),
        gewicht:         r.gewicht || null,
        shift:           ritnummer.charAt(0) || shift,
      }
    })

  console.log(`Shift ${shift}: ${resultaat.length} ritten`)
  return resultaat
}

async function opslaanInSupabase(alleRitten, datum, depotNaam, markeerGereden = false, statusVoorNieuw = 'gepland') {
  const nu = new Date().toISOString()
  const klantId = KLANT_ID

  // Haal ALLE bestaande ritten op voor datum + depot (ook eventuele duplicaten)
  const { data: bestaande } = await supabase
    .from('ritten').select('id, ritnummer')
    .eq('datum', datum).eq('depot', depotNaam)

  // Groepeer op genormaliseerd ritnummer
  const groepen = new Map()
  for (const r of bestaande ?? []) {
    const key = String(parseInt(r.ritnummer, 10))
    if (!groepen.has(key)) groepen.set(key, [])
    groepen.get(key).push(r.id)
  }

  // Verwijder dubbele rijen — bewaar enkel de eerste (oudste) per ritnummer
  for (const [rnr, ids] of groepen) {
    if (ids.length > 1) {
      await supabase.from('ritten').delete().in('id', ids.slice(1))
      console.log(`[${depotNaam}] ${datum}: rit ${rnr} had ${ids.length} dubbelen, ${ids.length - 1} verwijderd`)
    }
  }

  // Bouw map: genormaliseerd ritnummer → enig overgebleven id
  const bestaandeMap = new Map([...groepen.entries()].map(([k, ids]) => [k, ids[0]]))

  const teUpdaten = []
  const teInserten = []

  for (const rit of alleRitten) {
    const velden = {
      postnl_stops:            rit.stops,
      postnl_stuks:            rit.stuks,
      postnl_volume:           rit.volume,
      postnl_briefbusstops:    rit.brievenbusstops,
      postnl_gewicht:          rit.gewicht,
      postnl_chauffeur:        rit.chauffeur,
      postnl_shift:            rit.shift,
      postnl_ritnaam:          rit.ritnaam,
      postnl_laatst_opgehaald: nu,
      postnl_sync_status:      'opgehaald',
      postnl_sync_error:       null,
    }

    const id = bestaandeMap.get(rit.ritnummer)
    if (id) {
      teUpdaten.push({ id, ritnummer: rit.ritnummer, depot: depotNaam, ...velden })
    } else {
      teInserten.push({
        datum,
        status:    statusVoorNieuw,
        shift:     rit.shift,
        ritnummer: rit.ritnummer,
        depot:     depotNaam,
        klant_id:  klantId,
        ...velden,
      })
    }
  }

  await Promise.all([
    ...teUpdaten.map(({ id, ...v }) => supabase.from('ritten').update(v).eq('id', id)),
    teInserten.length ? supabase.from('ritten').insert(teInserten) : Promise.resolve(),
  ])

  if (markeerGereden) {
    await supabase.from('ritten').update({ status: 'gereden' })
      .eq('datum', datum).eq('depot', depotNaam).neq('status', 'gereden')
    console.log(`[${depotNaam}] Ritten van ${datum} op Gereden gezet`)
  }

  console.log(`[${depotNaam}] ${datum}: bijgewerkt ${teUpdaten.length}, nieuw ${teInserten.length}`)
}

// Navigates to dagplanning and returns the date select locator (or null if absent).
// Always navigates via the root URL so Mendix resets its state cleanly.
async function openDagplanning(page, depotUrl, depot) {
  await page.goto(depotUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2000)

  // OAuth-sessie soms niet volledig gevestigd na login — herlogin als we teruggestuurd worden
  if (page.url().includes('loginpostnl') || page.url().includes('/authorize')) {
    console.log(`[${depot?.naam ?? depotUrl}] Herleid naar login in openDagplanning — herlogin...`)
    await loginPostnl(page, depot)
    await page.waitForTimeout(3000)
  }

  await page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first().waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first().click()
  await page.waitForTimeout(600)
  await page.locator('a.mx-name-menuBar1-2-0, a[title="Dagplanning"]').first().click()
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1000)

  const datumSelect = page.locator('select.form-control').first()
  return (await datumSelect.count() > 0) ? datumSelect : null
}

async function syncDepot(depot, markeerGereden = false, allesDatums = false, syncDatum = null) {
  const vandaag = vandaagNl()
  const logLabel = syncDatum ? `voor ${syncDatum}` : allesDatums ? '(alle datums)' : `voor ${vandaag}`
  console.log(`[${depot.naam}] Start sync ${logLabel}`)

  const launchOptions = { headless: CONFIG.headless, slowMo: CONFIG.slowMo, args: ['--disable-dev-shm-usage'] }
  if (process.env.CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  metProxy(launchOptions, depot.naam)
  const browser = await chromium.launch(launchOptions)

  const contextOptions = {}
  try {
    const fs = await import('node:fs')
    if (depot.storageState && fs.existsSync(depot.storageState)) contextOptions.storageState = depot.storageState
  } catch {}

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  try {
    await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})

    if (page.url().includes('loginpostnl') || page.url().includes('/login') || page.url().includes('/authorize')) {
      await loginPostnl(page, depot)
    }

    await page.waitForTimeout(3000)
    await page.screenshot({ path: `screenshot-${depot.naam.toLowerCase().replace(' ', '-')}.png` }).catch(e => console.log('Screenshot fout (niet kritiek):', e.message))
    console.log(`[${depot.naam}] Pagina URL:`, page.url())

    const eersteSelect = await openDagplanning(page, depot.url, depot)
    let teSyncen = []

    if (syncDatum) {
      const [jaar, maand, dag] = syncDatum.split('-')
      teSyncen = [{ datum: syncDatum, label: `${dag}-${maand}-${jaar}` }]
      console.log(`[${depot.naam}] Specifieke datum: ${syncDatum}`)
    } else if (allesDatums && eersteSelect) {
      const labels = await eersteSelect.evaluate(el =>
        Array.from(el.options).map(o => o.label.trim()).filter(Boolean)
      )
      teSyncen = labels
        .map(label => ({ label, datum: labelNaarDatum(label) }))
        .filter(d => d.datum && d.datum <= vandaag)
        .sort((a, b) => a.datum.localeCompare(b.datum))
      console.log(`[${depot.naam}] Te syncen datums: ${teSyncen.map(d => d.label).join(', ')}`)
    } else {
      const [jaar, maand, dag] = vandaag.split('-')
      teSyncen = [{ datum: vandaag, label: `${dag}-${maand}-${jaar}` }]
    }

    for (const { datum, label: datumLabel } of teSyncen) {
      const datumSelect = await openDagplanning(page, depot.url, depot)

      if (datumSelect) {
        const optieAanwezig = await datumSelect.evaluate(
          (el, lbl) => Array.from(el.options).some(o => o.label.trim() === lbl),
          datumLabel
        )
        if (!optieAanwezig) {
          console.log(`[${depot.naam}] Datum ${datumLabel} niet in dropdown, overgeslagen`)
          continue
        }
        await datumSelect.selectOption({ label: datumLabel })
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(1500)
        console.log(`[${depot.naam}] Datum geselecteerd: ${datumLabel}`)
      }

      const depotHostname = new URL(depot.url).hostname
      const alleRitten = []
      for (const shift of CONFIG.shifts) {
        let geprobeerd = 0
        while (geprobeerd < 2) {
          geprobeerd++
          try {
            alleRitten.push(...await leesShift(page, shift, depotHostname))
            break
          } catch (err) {
            if (!(err instanceof PageReloadError) || geprobeerd >= 2) {
              console.log(`[${depot.naam}] Shift ${shift}: overgeslagen na fout: ${err.message}`)
              break
            }
            console.log(`[${depot.naam}] Shift ${shift}: pagina herlaadde — Dagplanning opnieuw openen...`)
            const herlaadSelect = await openDagplanning(page, depot.url, depot)
            if (herlaadSelect) {
              const optie = await herlaadSelect.evaluate(
                (el, lbl) => Array.from(el.options).some(o => o.label.trim() === lbl),
                datumLabel
              )
              if (optie) {
                await herlaadSelect.selectOption({ label: datumLabel })
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
                await page.waitForTimeout(1500)
              }
            }
          }
        }
      }

      // Dedupliceer op ritnummer — als de tabel per shift dezelfde ritten toont,
      // bewaar de eerste (meest volledig ingevulde) versie
      const uniekRitten = [...new Map(alleRitten.map(r => [r.ritnummer, r])).values()]
      console.log(`[${depot.naam}] Totaal gevonden voor ${datum}: ${alleRitten.length} ritten (${uniekRitten.length} uniek)`)

      const isVerleden = datum < vandaag
      await opslaanInSupabase(
        uniekRitten,
        datum,
        depot.naam,
        markeerGereden && !isVerleden,
        isVerleden ? 'gereden' : 'gepland'
      )
    }

    if (depot.storageState) await context.storageState({ path: depot.storageState })
    console.log(`[${depot.naam}] Sync klaar`)
  } catch (error) {
    console.error(`[${depot.naam}] Sync mislukt:`, error)
    throw error
  } finally {
    await browser.close()
  }
}

async function koppelChauffeurs() {
  const klantId = KLANT_ID
  const { data: users } = await supabase
    .from('users').select('id, postnl_naam')
    .eq('klant_id', klantId)
    .not('postnl_naam', 'is', null).neq('postnl_naam', '')
  if (!users?.length) return
  let totaal = 0
  for (const u of users) {
    // .is('chauffeur_id', null) voorkomt dat een handmatige herindeling door
    // de dispatcher (RitForm/RitDetail) bij de volgende sync weer wordt
    // overschreven met de oorspronkelijke PostNL-koppeling — zie issue #71.
    const { data } = await supabase.from('ritten')
      .update({ chauffeur_id: u.id })
      .eq('klant_id', klantId)
      .eq('postnl_chauffeur', u.postnl_naam)
      .is('chauffeur_id', null)
      .select('id')
    totaal += data?.length ?? 0
  }
  if (totaal > 0) console.log(`Chauffeurs gekoppeld: ${totaal} ritten bijgewerkt`)
}

async function syncPostnlStops(markeerGereden = false, allesDatums = false, syncDatum = null) {
  const actieveDepots = await getDepots(supabase, KLANT_ID, 'postnl')
  if (actieveDepots.length === 0) throw new Error('Geen depots geconfigureerd (klant_credentials leeg voor deze klant)')
  console.log(`Start PostNL sync voor ${actieveDepots.map(d => d.naam).join(', ')}`)
  for (const depot of actieveDepots) {
    await syncDepot(depot, markeerGereden, allesDatums, syncDatum)
  }
  await koppelChauffeurs()
  console.log('Alle depots gesynchroniseerd')
}

const runOnce = process.argv.includes('--once') || process.env.RUN_ONCE === 'true'
const runAll  = process.argv.includes('--all')  || process.env.RUN_ALL  === 'true'
const runDatum = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || process.env.SYNC_DATUM || null

async function syncMetRetry(markeer, allesDatums = false, syncDatum = null, pogingen = 3) {
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      await syncPostnlStops(markeer, allesDatums, syncDatum)
      return
    } catch (err) {
      console.error(`Poging ${poging}/${pogingen} mislukt:`, err.message)
      if (poging < pogingen) {
        const wacht = poging * 30000
        console.log(`Wacht ${wacht / 1000}s voor volgende poging...`)
        await new Promise(r => setTimeout(r, wacht))
      } else {
        process.exit(1)
      }
    }
  }
}

if (runOnce || runAll || runDatum) {
  const markeer = process.env.MARKEER_GEREDEN === 'true'
  syncMetRetry(markeer, runAll, runDatum)
} else {
  // Cron: elke avond automatisch — zet ritten op Gereden
  cron.schedule(CONFIG.cronTime, () => {
    syncPostnlStops(true).catch(err => console.error(err))
  }, { timezone: CONFIG.timezone })

  // HTTP server: POST /sync, POST /sync-all, POST /optimaliseer-rit
  let bezig = false
  const port = Number(process.env.PORT || 3001)
  const workerSecret = process.env.WORKER_SECRET

  function leesBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) }
      })
    })
  }

  http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'POST' && (req.url === '/sync' || req.url === '/sync-all')) {
      if (bezig) { res.writeHead(409); res.end(JSON.stringify({ error: 'Sync al bezig' })); return }
      const allesDatums = req.url === '/sync-all'
      bezig = true
      syncPostnlStops(false, allesDatums).catch(err => console.error(err)).finally(() => { bezig = false })
      res.writeHead(200); res.end(JSON.stringify({ success: true, allesDatums }))

    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Niet gevonden' }))
    }
  }).listen(port, () => {
    console.log(`PostNL worker actief. Cron: ${CONFIG.cronTime}, HTTP: poort ${port}`)
  })
}
