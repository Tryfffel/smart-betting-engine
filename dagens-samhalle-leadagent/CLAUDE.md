# CLAUDE.md – orientering för framtida Claude-sessioner

Det här är en **lead-research-agent för Dagens Samhälles platsannonsaffär**.
Den hittar dagsfärska chefs- och specialistjobb i svensk offentlig sektor,
klassar A/B/C, berikar A-leads med kontaktperson och laddar upp output till
Google Drive.

## Snabbkarta

- `src/main.py` – CLI-entrypoint. `run`, `stats`, `upload`.
- `src/sources/jobtech.py` – primär källa, JobTech JobSearch API.
- `src/sources/linkedin.py` – sekundär källa, LinkedIn via Anthropic web_search.
- `src/filter.py` – klassar org-typ + roll mot `config/*.yaml`.
- `src/score.py` – Claude Haiku 4.5 ger A/B/C + motivering.
- `src/enrich.py` – Claude Sonnet 4.6 + web_search letar kontaktperson på A-leads.
- `src/storage.py` – SQLite (`data/leads.db`), dedup på `annons_id`.
- `src/export.py` – `outputs/YYYY-MM-DD/leads_master.xlsx` + per-lead `.md`.
- `src/drive.py` – Google Drive-upload via service account.

## Pipeline-flöde

```
jobtech.fetch_ads ─┐
                   ├─► storage.filter_new ─► filter.classify_batch ─► score.score_batch ─► enrich.enrich_a_leads ─► storage.upsert_leads ─► export.write_outputs ─► drive.upload_run
linkedin.fetch_ads ┘
                  (cross-dedup)
```

## Vanliga ändringar

- **Lägg till en myndighet/byrå:** redigera `config/organisationer.yaml`.
- **Justera roller:** `config/roller_a_lead.yaml` eller `exkluderingar.yaml`.
- **Lägg till LinkedIn-sökfras:** `config/linkedin_queries.yaml` (max ~15).
- **Ändra scoring-logik:** systemprompten i `src/score.py`.
- **Ändra kolumner i Excel:** `COLUMNS` + `_lead_row` i `src/export.py`.

## Modeller

- Scoring: `claude-haiku-4-5-20251001`
- Enrich + LinkedIn-source: `claude-sonnet-4-6`
- `web_search`-tool: `web_search_20250305`

## Inte i scope

- Mail-utskick. Ingen mall-generering, ingen send-logik.
- Inloggat LinkedIn-skrapande. Bara publika sökresultat.
- Sekundära jobbsajter (offentligajobb.se, varbi.se, visma recruit) – `# TODO fas 2`.
- LinkedIn-djupanalys (det görs av en separat agent David har).

## Schema

GitHub Actions cron `30 5 * * 1,3,5` (mån/ons/fre 05:30 UTC).
`data/leads.db` committas tillbaka till branchen efter varje körning för
att dedupera mot tidigare körningar (med `[skip ci]` så cron inte triggar
sig själv i en loop).

## Hemligheter (GitHub Secrets)

- `ANTHROPIC_API_KEY`
- `GOOGLE_SA_JSON` – hela service-account-JSON:en inklistrad
- `GOOGLE_DRIVE_FOLDER_ID` – mål-mappen i Drive (måste vara delad med SA-mailen)

## Felsökning

- **"ANTHROPIC_API_KEY saknas"** – kolla `.env` lokalt eller Secrets i Actions.
- **JobTech ger 0 hits** – verifiera `published-after`-formatet med `curl
  https://jobsearch.api.jobtechdev.se/search?published-after=2026-05-11T00:00:00&limit=1`.
- **Drive 403** – mappen är inte delad med service-accountets email.
- **Tomma A-leads** – kolla filter-loggen för "okänd org" → arbetsgivaren
  finns inte i `organisationer.yaml`.
