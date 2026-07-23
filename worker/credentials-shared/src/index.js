// Herbruikbare per-klant credential-opslag voor alle scrape-workers
// (postnl-sync, postnl-ritmonitor, movemove-sync, route-optimalisatie).
//
// Voorheen bouwde elke worker zijn eigen DEPOTS-array uit VPS-brede env-vars
// (POSTNL_USERNAME_HBD, POSTNL_USERNAME_WVN, ...) — drie keer apart
// geïmplementeerd, met een inconsistente fallback tussen de varianten. Nu
// staan credentials per klant in de database (tabel `klant_credentials`,
// wachtwoord versleuteld met AES-256-GCM), en haalt elke worker ze hier op.
//
// De versleutelingssleutel (`CREDENTIALS_ENCRYPTION_KEY`, 64-char hex = 32
// bytes) leeft alleen in vps-server's .env — workers erven 'm automatisch
// via `spawn(..., { env: { ...process.env } })`, geen aparte doorgifte nodig.
// Dezelfde sleutel staat ALLEEN daar en als secret bij de
// `klant-credentials`-edge-function (die versleutelt bij het opslaan) —
// nooit in de database zelf.

import crypto from 'node:crypto'

export function encrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

export function decrypt(encryptedText, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const [ivHex, authTagHex, ciphertextHex] = encryptedText.split(':')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Haalt actieve credentials op voor een klant + systeem, ontsleuteld, in de
 * DEPOTS-vorm die postnl-sync/postnl-ritmonitor/route-optimalisatie verwachten.
 *
 * @param {object} supabase - Supabase-client (service role)
 * @param {string} klantId
 * @param {'postnl'|'movemove'} systeem
 * @returns {Promise<Array<{naam: string|null, url: string|null, username: string, password: string, storageState: string}>>}
 */
export async function getDepots(supabase, klantId, systeem) {
  if (!klantId) throw new Error('getDepots: klantId ontbreekt')
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('getDepots: CREDENTIALS_ENCRYPTION_KEY ontbreekt in env')

  const { data, error } = await supabase
    .from('klant_credentials')
    .select('depot_naam, depot_url, username, password_encrypted')
    .eq('klant_id', klantId)
    .eq('systeem', systeem)
    .eq('actief', true)
  if (error) throw error

  return (data ?? []).map(d => ({
    naam: d.depot_naam,
    url: d.depot_url,
    username: d.username,
    password: decrypt(d.password_encrypted, key),
    storageState: `.${systeem}-auth-state-${(d.depot_naam ?? 'default').toLowerCase().replace(/\s+/g, '-')}.json`,
  }))
}
