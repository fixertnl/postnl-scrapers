// Optionele proxy voor de PostNL-scrapers.
//
// PostNL's Akamai-beveiliging blokkeert het datacenter-IP van de VPS als er te
// veel geautomatiseerd verkeer vanaf één vast adres komt. Een residential /
// roterende proxy laat elk verzoek via een ander echt-uitziend IP gaan, zodat
// er geen vast doelwit is om te blokkeren.
//
// Zet in de VPS-.env (leeg laten = direct verbinden, ongewijzigd gedrag):
//   PROXY_SERVER=http://gateway.provider.com:7000
//   PROXY_USERNAME=...        (optioneel)
//   PROXY_PASSWORD=...        (optioneel)
//
// Geeft een Playwright `proxy`-object terug, of null als er geen proxy is
// ingesteld. Bedoeld om in launchOptions te spreiden: { ...proxyConfig() }.
export function proxyConfig() {
  const server = process.env.PROXY_SERVER
  if (!server) return null
  const proxy = { server }
  if (process.env.PROXY_USERNAME) proxy.username = process.env.PROXY_USERNAME
  if (process.env.PROXY_PASSWORD) proxy.password = process.env.PROXY_PASSWORD
  return proxy
}

// Voegt de proxy toe aan launchOptions én logt (zonder wachtwoord) of hij actief is.
export function metProxy(launchOptions, label = '') {
  const proxy = proxyConfig()
  if (proxy) {
    launchOptions.proxy = proxy
    console.log(`${label ? `[${label}] ` : ''}Proxy actief: ${proxy.server}`)
  }
  return launchOptions
}
