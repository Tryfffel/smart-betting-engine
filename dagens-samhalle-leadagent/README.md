# Dagens Samhälle – Lead-research-agent

Hittar dagsfärska chefs- och specialistjobb i svensk offentlig sektor,
klassar dem A/B/C, berikar A-leads med kontaktperson, exporterar till Excel +
Markdown och laddar upp till Google Drive.

**Körs via Claude Code** (man/ons/fre eller på begäran). Claude Code
orkestrerar tre källor + Python-pipelinen + Drive-upload — se
[`RUNBOOK.md`](./RUNBOOK.md) för det fullständiga flödet.

## Källor

- **JobTech JobSearch API** (https://jobsearch.api.jobtechdev.se) – täcker
  Platsbanken som i sin tur fångar ~90 % av offentlig rekrytering.
- **LinkedIn Jobs** via Anthropics `web_search`-tool – fångar annonser som
  bara läggs på LinkedIn (typiskt rekryteringsbyråer).
- **Indeed** via Claude Codes MCP `search_jobs`-tool – kompletterar de
  två ovan med Indeed-publicerade annonser från byråer som Poolia, Sway m.fl.

## Hur det körs

David säger till Claude Code: **"kör leadagent"**. Claude följer
[`RUNBOOK.md`](./RUNBOOK.md):

1. Anropar MCP `search_jobs` för varje fras i `config/indeed_queries.yaml`,
   parsar och sparar JSON till `/tmp/leadagent_indeed.json`.
2. Kör `uv run python -m src.main run --days 3` som gör resten:
   JobTech-hämtning, LinkedIn-hämtning, filter, A/B/C-scoring, enrichment,
   export till `outputs/YYYY-MM-DD/`.
3. Laddar upp `outputs/YYYY-MM-DD/`-mappen till Davids Drive via MCP.
4. Committar uppdaterad `data/leads.db` så nästa körning dedupar mot
   tidigare ID:n.

## Snabbstart lokalt (bara Python-delen)

```bash
uv sync
cp .env.example .env
$EDITOR .env  # fyll i ANTHROPIC_API_KEY

# Rökrunda – ingen LinkedIn-tokenförbrukning, ingen Indeed
uv run python -m src.main run --days 3 --no-enrich --no-linkedin --no-indeed

# Full pipeline (utan Indeed eftersom MCP-staging-filen saknas)
uv run python -m src.main run --days 3

# Se DB-statistik
uv run python -m src.main stats

# Återskapa outputs/ från DB:n (om export-formatet ändrats)
uv run python -m src.main rebuild 2026-05-14
```

## CLI-flaggor

```
run [--days INT] [--no-enrich] [--no-linkedin] [--no-indeed]
  --days        Antal dagar bakåt att hämta annonser (default 3)
  --no-enrich   Hoppa över kontaktperson-sökning för A-leads
  --no-linkedin Hoppa över LinkedIn-källan (web_search-tokens)
  --no-indeed   Hoppa över Indeed-staging-filen

stats           Visa antal leads per score från leads.db

rebuild DATE    Återskapa outputs/DATE/ från DB:n (YYYY-MM-DD)
```

Drive-upload ligger **inte** i CLI:t — det sker via Claude Code MCP (se RUNBOOK).

## Output

Allt skrivs till `outputs/YYYY-MM-DD/`:

- `leads_master.xlsx` – alla leads, A först. Conditional formatting,
  autofilter, frusen header.
- `daglig_logg.csv` – dagens nya leads i CSV-form.
- `a_leads/<org>_<roll>.md` – en Markdown-fil per A-lead med kontakt-block
  och pitch-notering.

## Konfiguration

Fyra YAML-filer styr matchning:

- `config/organisationer.yaml` – 290 kommuner, 21 regioner, ~80 myndigheter,
  kommunala bolag-suffix, rekryteringsbyråer.
- `config/roller_a_lead.yaml` – mål-roller (chef + specialist).
- `config/exkluderingar.yaml` – roller som filtreras bort (lärare etc).
- `config/linkedin_queries.yaml` – Google-sökfraser för LinkedIn-källan.
- `config/indeed_queries.yaml` – Indeed-sökfraser för MCP `search_jobs`.

Lägg till nya org/roller här – ingen kodändring krävs.

## Modellval

- **Scoring:** `claude-haiku-4-5-20251001` (snabb + billig, hög volym).
- **Enrich + LinkedIn-source:** `claude-sonnet-4-6` (web_search-toolen ger
  bättre resonemang).

Pris-snitt per körning: ~$0.30 (200 ads × Haiku + ~30 A-leads × Sonnet +
~10 LinkedIn-queries × Sonnet). Indeed via MCP är gratis.
