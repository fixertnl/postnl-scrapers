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
(in het `fixertnl/matransport`-project) via de GitHub API, met Vault-secret
`postnl_scrapers_token` (rechtstreeks vanuit `public.trigger_postnl_sync()` /
`public.trigger_ritmonitor()` — geen tussenstap via een VPS meer).
**Nooit `on: schedule`** gebruiken: dat vuurt minuten tot uren te laat.

⚠️ Deze functies zijn ooit rechtstreeks in de Supabase-database aangepast, niet
via een migratiebestand in `matransport` — check bij twijfel de live definitie
(`select pg_get_functiondef(oid) from pg_proc where proname = 'trigger_ritmonitor'`)
i.p.v. op matransport's migratiebestanden te vertrouwen.

Handmatig testen kan via **Actions → (workflow kiezen) → Run workflow**, of
`gh workflow run postnl-ritmonitor.yml` / `postnl-sync.yml`.

## Structuur

```
worker/postnl-sync/              Dagplanning-scraper (ritten + stops)
worker/postnl-ritmonitor/        Live voortgang per rit
  POSTNL_RITMONITOR.md           Volledige technische documentatie (lees dit eerst)
worker/credentials-shared/       Ontsleutelt klant_credentials (crypto)
worker/postnl-shared/            Optionele proxy-helper (hier niet nodig — elke
                                  Actions-run heeft al een eigen IP)
.github/workflows/                De twee Actions-workflows
```

## Relatie met `fixertnl/matransport`

Deze repo is de **enige** bron voor de PostNL-scrape-logica sinds 2026-08-25 —
de hoofd-app-repo (`fixertnl/matransport`) had eerder eigen kopieën van beide
workers (via een always-on VPS), maar die zijn verwijderd toen bleek dat de
automatische triggers hier via GitHub Actions liepen, niet via die VPS. Een fix
aan scrape-/parse-/tijdzone-/chauffeur-koppel-logica hoort dus **hier**, nooit
in `matransport`. Zie `matransport`'s `CLAUDE.md` § PostNL integration voor het
bredere app-datamodel (welke kolommen in `ritten` deze workers vullen, hoe de
Ritten-pagina de live voortgang toont, enz.).
