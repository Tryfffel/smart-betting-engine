# CLAUDE.md – orientering för framtida Claude-sessioner

Det här är en **lead-research-agent för Dagens Samhälles platsannonsaffär**.
Den hittar dagsfärska chefs- och specialistjobb i svensk offentlig sektor,
klassar A/B/C, berikar A-leads med kontaktperson och laddar upp output till
Google Drive.

**Viktigt:** Agenten körs via Claude Code-orkestrering (MCP-tools), inte
autonomt. När David säger "kör leadagent", följ [`RUNBOOK.md`](./RUNBOOK.md)
exakt.

## Snabbkarta

- `RUNBOOK.md` – **läs först** när David vill köra agenten.
- `src/main.py` – CLI-entrypoint för Python-delen. `run`, `stats`, `rebuild`.
- `src/sources/jobtech.py` – primär källa, JobTech JobSearch API (httpx async).
- `src/sources/linkedin.py` – LinkedIn via Anthropic web_search (Sonnet).
- `src/sources/indeed.py` – Indeed via JSON-staging-fil som Claude Code
  fyller på i förväg från MCP `search_jobs`.
- `src/sources/politiker.py` – kommunstyrelseordförande + regionstyrelse-
  ordförande via Wikidata SPARQL + seed-fallback. Adderat efter workshop
  2026-05-21 ("bredda till politiskt engagerade").
- `src/sources/signals.py` – tidiga rekryterings-signaler från
  pressmeddelanden, fullmäktige-protokoll och LinkedIn-poster. Sonnet
  extraherar strukturerade signaler från råtext. Skriver separat
  `outputs/YYYY-MM-DD/signals.csv` istället för att blandas in i leads.
- `src/filter.py` – klassar org-typ + roll mot `config/*.yaml`.
- `src/score.py` – Claude Haiku 4.5 ger A/B/C + motivering (prompt-caching).
- `src/enrich.py` – Claude Sonnet 4.6 + web_search letar kontaktperson på A-leads.
- `src/storage.py` – SQLite (`data/leads.db`), dedup på `annons_id`.
- `src/export.py` – `outputs/YYYY-MM-DD/leads_master.xlsx` + per-lead `.md`.

Det finns **ingen** `src/drive.py` längre — Drive-upload görs via MCP
(`mcp__d49795e9-83e4-475d-89c6-b29927d4b3e8__create_file` m.fl.) som
Claude Code anropar direkt enligt RUNBOOK steg 3.

## Pipeline-flöde

```
[MCP search_jobs] ─► /tmp/leadagent_indeed.json ─┐
jobtech.fetch_ads ─────────────────────────────────┤
linkedin.fetch_ads (Sonnet+web_search) ────────────┤
                                                    ├─► cross-dedup
                                                    ▼
                            storage.filter_new (mot leads.db)
                                       ▼
                            filter.classify_batch (org/roll-match)
                                       ▼
                            score.score_batch (Haiku → A/B/C + motivering)
                                       ▼
                            enrich.enrich_a_leads (Sonnet+web_search för A-leads)
                                       ▼
                            storage.upsert_leads (SQLite)
                                       ▼
                            export.write_outputs (xlsx + csv + md)
                                       ▼
                            [MCP Drive create_file] (orkestrerat av Claude Code)
```

## Vanliga ändringar

- **Lägg till en myndighet/byrå:** redigera `config/organisationer.yaml`.
- **Justera roller:** `config/roller_a_lead.yaml` eller `exkluderingar.yaml`.
- **Lägg till LinkedIn-sökfras:** `config/linkedin_queries.yaml` (~10).
- **Lägg till Indeed-sökfras:** `config/indeed_queries.yaml` (~7).
- **Ändra scoring-logik:** systemprompten i `src/score.py`.
- **Ändra kolumner i Excel:** `COLUMNS` + `_lead_row` i `src/export.py`.

## Modeller

- Scoring: `claude-haiku-4-5-20251001`
- Enrich + LinkedIn-source: `claude-sonnet-4-6`
- `web_search`-tool: `web_search_20250305`

## MCP-servrar som används

- `mcp__c4a33bac-f178-492d-beb7-964065ef5d61__search_jobs` – Indeed
- `mcp__d49795e9-83e4-475d-89c6-b29927d4b3e8__*` – Google Drive (Davids konto)

Om en av dessa MCP-servrar inte är connectad: rapportera till David och
fråga om man ska köra utan den källan/funktionen, eller vänta.

## Inte i scope

- Mail-utskick. Ingen mall-generering, ingen send-logik.
- Inloggat LinkedIn-skrapande. Bara publika sökresultat via Anthropics web_search.
- Sekundära jobbsajter (offentligajobb.se, varbi.se, visma recruit) – `# TODO fas 2`.
- LinkedIn-djupanalys (det görs av en separat agent David har).
- Autonom körning via cron/GitHub Actions – David triggar manuellt via
  Claude Code (man/ons/fre).

## Felsökning

- **"ANTHROPIC_API_KEY saknas"** – kolla `.env` lokalt.
- **JobTech ger 0 hits** – verifiera `published-after`-formatet med `curl
  https://jobsearch.api.jobtechdev.se/search?published-after=$(date -u -d '3 days ago' +%FT%TZ)&limit=1`.
- **Indeed-staging-filen saknas eller är gammal** – Python loggar varning
  och kör vidare utan Indeed-träffar. Kör RUNBOOK Steg 1 igen.
- **MCP Drive create_file 403/permission denied** – mappen David valt är
  inte skrivbar för det Drive-konto MCP är connectat med. Fråga David.
- **Tomma A-leads** – kolla filter-loggen för "okänd org" → arbetsgivaren
  finns inte i `organisationer.yaml`.
