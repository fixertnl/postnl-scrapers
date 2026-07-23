# PostNL scrapers

Losstaande scrapers voor het PostNL OOM PD-portaal (Dagplanning + Ritmonitor),
draaiend op GitHub Actions. Bewust een **aparte publieke repo**: GitHub Actions is
gratis en ongelimiteerd voor publieke repo's, en elke run krijgt een ander IP uit
de GitHub-pool — waardoor de Akamai IP-blokkade die de VPS trof hier geen grip heeft.

Er staan **geen geheimen** in deze repo. Alle inloggegevens en sleutels komen uit
GitHub Secrets (zie hieronder). De PostNL-logins zelf staan versleuteld in de
Supabase-tabel `klant_credentials` en worden per run ontsleuteld met
`CREDENTIALS_ENCRYPTION_KEY`.

## Benodigde GitHub Secrets

Instellen via **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Waar te vinden |
|--------|----------------|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | idem (service_role, niet de anon key) |
| `CREDENTIALS_ENCRYPTION_KEY` | zelfde waarde als in de VPS-`.env` |
| `KLANT_ID` | de klant-UUID (M&A Transport) |

## Triggeren

De workflows draaien op `workflow_dispatch` — getriggerd door Supabase `pg_cron`
via de GitHub API (zelfde patroon als vroeger, `github_dispatch_token` in Vault).
**Nooit `on: schedule`** gebruiken: dat vuurt minuten tot uren te laat.

Handmatig testen kan via **Actions → (workflow kiezen) → Run workflow**.

## Structuur

```
worker/postnl-sync/         Dagplanning-scraper (ritten + stops)
worker/postnl-ritmonitor/   Live voortgang per rit
worker/credentials-shared/  Ontsleutelt klant_credentials (crypto)
worker/postnl-shared/       Optionele proxy-helper (hier niet nodig)
.github/workflows/          De twee Actions-workflows
```
