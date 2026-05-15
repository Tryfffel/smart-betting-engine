# RUNBOOK – så här kör du leadagent-pipelinen

Den här filen är skriven för **Claude Code-sessioner**. När David säger
"kör leadagent" (eller motsvarande), följ stegen nedan i ordning. Stegen
kombinerar lokala Python-anrop med MCP-tool-anrop som Python inte kan göra
själv.

## Förutsättningar att verifiera först

1. `dagens-samhalle-leadagent/.env` finns och innehåller `ANTHROPIC_API_KEY`.
2. MCP-server för Google Drive är connectad (`mcp__d49795e9-...__*`-tools tillgängliga).
3. MCP-server för Indeed är connectad (`mcp__c4a33bac-...__search_jobs` tillgängligt).
4. Davids Drive-mapp för leads finns. Om inte, fråga honom om id eller skapa en.

## Steg 1 – Hämta Indeed-annonser via MCP

Läs `config/indeed_queries.yaml`. För varje query, anropa
`mcp__c4a33bac-...__search_jobs` med:
- `search`: querysträngen
- `location`: "Sverige" (eller specifik om annat anges i yaml)
- `country_code`: "SE"

Resultaten är **markdown**. Parsa till JSON-lista med formatet:
```json
[
  {
    "job_id": "JOB_129",
    "title": "Biträdande förvaltningschef till …",
    "company": "Poolia",
    "location": "Skåne Län",
    "posted_on": "April 28, 2026",
    "apply_url": "https://to.indeed.com/aabq77kh2ybm",
    "description": ""
  }
]
```

Spara den sammanslagna listan (alla queries tillsammans, dedupad på `job_id`) som:
```
/tmp/leadagent_indeed.json
```

Säg till David hur många unika Indeed-träffar du hittade.

## Steg 2 – Kör Python-pipelinen lokalt

```bash
cd dagens-samhalle-leadagent
uv run python -m src.main run --days 3
```

Flaggor:
- `--days N` – senaste N dagarna (default 3, sätt 7 vid måndag-körning så
  helgen täcks)
- `--no-enrich` – snabb rökrunda utan kontaktperson-sökning
- `--no-linkedin` – skippa LinkedIn-källan om Anthropic-tokens måste sparas
- `--no-indeed` – skippa Indeed-staging-filen

Pipelinen skriver:
- `outputs/YYYY-MM-DD/leads_master.xlsx`
- `outputs/YYYY-MM-DD/daglig_logg.csv`
- `outputs/YYYY-MM-DD/a_leads/<org>_<roll>.md` (en per A-lead)
- `data/leads.db` (uppdaterad)

Loggraderna ger antal A/B/C – rapportera till David.

## Steg 3 – Ladda upp till Google Drive via MCP

1. Lista mappar med `mcp__d49795e9-...__search_files` eller
   `list_recent_files` för att hitta Davids "Dagens Samhälle – Leads"-mapp.
   Om den inte finns, fråga David om id eller skapa via MCP.
2. Skapa undermapp `YYYY-MM-DD` i mål-mappen (samma datum som Steg 2 körde).
3. För varje fil under `outputs/YYYY-MM-DD/`:
   - `leads_master.xlsx` – ladda upp som `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
     (eller låt Drive konvertera till Google Sheets om David föredrar det)
   - `daglig_logg.csv` – som `text/csv`
   - `a_leads/*.md` – ladda upp i en `a_leads`-undermapp under datum-mappen
4. Använd MCP `create_file` (eller motsvarande write-verktyg) för varje fil.
   Läs filinnehållet med Read-tool och passa till MCP.

Rapportera till David vilka filer som laddades upp och länken till
datum-mappen.

## Steg 4 – Commita uppdaterad leads.db

Pipelinen uppdaterar `data/leads.db` med nya/uppdaterade leads. Eftersom
denna fil committas tillbaka mellan körningar för dedup-historik:

```bash
git add dagens-samhalle-leadagent/data/leads.db
git commit -m "chore: leadagent körning $(date +%F)"
git push origin claude/lead-research-agent-FLkSF
```

(Endast om det finns ändringar – `git diff --staged --quiet` skippar tomma
commits.)

## Steg 5 – Städa staging-filen

```bash
rm -f /tmp/leadagent_indeed.json
```

Detta hindrar att gamla Indeed-träffar smyger in i nästa körning om någon
glömmer Steg 1.

## Kortform-summering till David

Avsluta med en kort sammanfattning:

```
✓ Hämtade X annonser (JobTech Y + LinkedIn Z + Indeed W)
✓ Y nya efter dedup → A: a, B: b, C: c
✓ Kontaktperson hittad för n / a A-leads
✓ Uppladdat till Drive: <länk till datum-mappen>
```

## Schemalagd körning (launchd)

Pipelinen körs automatiskt **måndag och torsdag kl 07:00** via macOS
`launchd`. Wrapper-skript och plist-template ligger i `scripts/`.

### Installation (engångsjobb)

Det finns ett skript som gör hela installationen åt dig — det auto-detekterar
projektsökvägen, substituerar in den i plisten, kopierar till
`~/Library/LaunchAgents/`, och laddar jobbet med `launchctl`. Idempotent:

```bash
./scripts/install_schedule.sh
```

**Verifiera att det är listat:**
```bash
launchctl print gui/$(id -u)/se.dagenssamhalle.leadagent | grep -E '(state|next fire)'
```

### Manuell installation (om du föredrar det)

1. Byt ut `/Users/CHANGEME/path/to/dagens-samhalle-leadagent` i
   `scripts/se.dagenssamhalle.leadagent.plist` mot din faktiska sökväg
   (3 ställen).
2. `cp scripts/se.dagenssamhalle.leadagent.plist ~/Library/LaunchAgents/`
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/se.dagenssamhalle.leadagent.plist`
4. `launchctl enable gui/$(id -u)/se.dagenssamhalle.leadagent`

### Testkör utan att vänta till måndag

```bash
launchctl kickstart -k gui/$(id -u)/se.dagenssamhalle.leadagent
tail -f logs/runs.log
```

### Avinstallera / pausa

```bash
./scripts/uninstall_schedule.sh
```
(eller manuellt: `launchctl bootout gui/$(id -u)/se.dagenssamhalle.leadagent`
och radera `~/Library/LaunchAgents/se.dagenssamhalle.leadagent.plist`)

### Ändra schema

Edita `~/Library/LaunchAgents/se.dagenssamhalle.leadagent.plist` —
`StartCalendarInterval` styr veckodagar och tider. Weekday 1=mån, 2=tis,
3=ons, 4=tor, 5=fre, 6=lör, 0/7=sön. Efter ändring:
```bash
launchctl bootout gui/$(id -u)/se.dagenssamhalle.leadagent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/se.dagenssamhalle.leadagent.plist
```

### Logging

- `logs/runs.log` – pipelinens stdout/stderr per körning.
- `logs/launchd.out.log` / `logs/launchd.err.log` – launchd-nivå (start/stopp/exit codes).

Båda är gitignored.

### Macen sover vid 07:00?

launchd kör inte schemalagda jobb medan datorn sover. Sätt på "Wake for
network access" i Systeminställningar → Energisparare, eller väck Macen
explicit 5 min innan:
```bash
sudo pmset repeat wakeorpoweron MR 06:55:00
```
(MR = Mondays + thuRsdays. Se `man pmset`.)

## När något går fel

- **JobTech ger 0 träffar:** kontrollera `published-after`-formatet och
  prova `curl https://jobsearch.api.jobtechdev.se/search?published-after=$(date -u -d '3 days ago' +%FT%TZ)&limit=1`.
- **Indeed-staging-filen är gammal/saknas:** Python loggar varning och kör utan
  Indeed-träffar. Kör Steg 1 igen och repetera Steg 2.
- **Drive-MCP saknar skrivrätt på mappen:** be David om en mapp som hans
  Drive-konto kan skriva till.
- **Sonnet/Haiku 429:** Anthropic rate limit. Vänta, kör igen med
  `--no-linkedin` (sparar tokens).
