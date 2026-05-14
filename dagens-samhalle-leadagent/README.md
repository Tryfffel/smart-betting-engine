# Dagens Samhälle – Lead-research-agent

Hittar dagsfärska chefs- och specialistjobb i svensk offentlig sektor,
klassar dem A/B/C, berikar A-leads med kontaktperson, exporterar till Excel +
Markdown och laddar upp till Google Drive.

Körs automatiskt **måndag, onsdag, fredag** via GitHub Actions och kan även
köras manuellt från terminalen.

## Källor

- **JobTech JobSearch API** (https://jobsearch.api.jobtechdev.se) – täcker
  Platsbanken som i sin tur fångar ~90 % av offentlig rekrytering.
- **LinkedIn Jobs** via Anthropics `web_search`-tool – fångar annonser som
  bara läggs på LinkedIn (typiskt rekryteringsbyråer).

## Snabbstart lokalt

```bash
# Engångssetup
uv sync
cp .env.example .env
$EDITOR .env  # fyll i ANTHROPIC_API_KEY, GOOGLE_SA_JSON_PATH, GOOGLE_DRIVE_FOLDER_ID

# Rökrunda – snabb, hoppar webbsök och Drive-upload
uv run python -m src.main run --days 3 --no-enrich --no-upload

# Full körning
uv run python -m src.main run --days 3

# Hoppa bara över Drive-upload (om du inte vill ladda upp)
uv run python -m src.main run --no-upload

# Hoppa över LinkedIn-källan (sparar Anthropic-tokens)
uv run python -m src.main run --no-linkedin

# Se DB-statistik
uv run python -m src.main stats

# Ladda upp en gammal körning manuellt
uv run python -m src.main upload 2026-05-13
```

## CLI-flaggor

```
run [--days INT] [--no-enrich] [--no-upload] [--no-linkedin]
  --days        Antal dagar bakåt att hämta annonser (default 3)
  --no-enrich   Hoppa över kontaktperson-sökning för A-leads
  --no-upload   Skriv bara lokalt, ladda inte upp till Drive
  --no-linkedin Hoppa över LinkedIn-källan (bara JobTech)

stats           Visa antal leads per score från leads.db

upload DATE     Ladda upp outputs/DATE/ till Drive (DATE = YYYY-MM-DD)
```

## Output

Allt skrivs till `outputs/YYYY-MM-DD/`:

- `leads_master.xlsx` – alla leads, A först. Kolumner:
  `score, organisation, org_typ, roll, publicerad, sista_ansokningsdag,
  ansvarig_rekryterare, kontakt_namn, kontakt_titel, kontakt_email,
  kontakt_kalla, annons_url, annons_id, platsbanken, linkedin_finns,
  motivering, status`. Conditional formatting (A=grön, B=gul, C=grå),
  autofilter, frusen header.
- `daglig_logg.csv` – dagens nya leads i CSV-form.
- `a_leads/<org>_<roll>.md` – en Markdown-fil per A-lead.

## Setup för automatisk körning (GitHub Actions)

1. **Google Cloud:**
   - Skapa projekt → aktivera Drive API
   - Skapa service account → ladda ner JSON-nyckel
2. **Google Drive:**
   - Skapa mapp ("Dagens Samhälle – Leads")
   - Dela mappen med service-accountets email som **Editor**
   - Kopiera mappens id från URL:en
3. **GitHub Secrets** (Settings → Secrets and variables → Actions):
   - `ANTHROPIC_API_KEY` – Anthropic-nyckel
   - `GOOGLE_SA_JSON` – hela service-account-JSON:en (inklistrad)
   - `GOOGLE_DRIVE_FOLDER_ID` – mappens id

Cron är satt till `30 5 * * 1,3,5` (mån/ons/fre kl 05:30 UTC ≈ 06:30–07:30
Stockholm). Manuell trigger via "Run workflow" i Actions-fliken.

`data/leads.db` committas tillbaka till branchen efter varje körning för att
dedupera mot tidigare körningar.

## Konfiguration

Tre YAML-filer styr matchning:

- `config/organisationer.yaml` – kommuner (290), regioner (21), myndigheter,
  kommunala bolag, rekryteringsbyråer.
- `config/roller_a_lead.yaml` – mål-roller (chef + specialist).
- `config/exkluderingar.yaml` – roller som filtreras bort (lärare etc).
- `config/linkedin_queries.yaml` – Google-sökfraser för LinkedIn-källan.

Lägg till nya org/roller här – ingen kodändring krävs.

## Modellval

- **Scoring:** `claude-haiku-4-5-20251001` (snabb + billig, hög volym).
- **Enrich + LinkedIn-source:** `claude-sonnet-4-6` (web_search-toolen ger
  bättre resonemang).

Pris-snitt per körning: ~$0.30 (200 ads × Haiku + ~30 A-leads × Sonnet +
~10 LinkedIn-queries × Sonnet).
