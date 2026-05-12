# Smart Betting Engine — Reducering Agent

Node.js agent that scrapes the current Stryktipset/Europatipset round from
[reducering.se](https://reducering.se), enriches every match with deep team
and head-to-head data via [API-Football](https://www.api-football.com), runs the
shared Dixon-Coles model, and builds a reduction system.

The browser app (`../index.html`, "Reducering" tab) reads the JSON files this
agent writes to `output/`.

## Setup

```bash
cd agent
npm install                                       # only dep is cheerio
echo "API_FOOTBALL_KEY=your-key-here" > .env      # API-Football key
```

API-Football's free tier is **100 requests/day** — too low. The basic plan
(7500/day) is enough; with the on-disk cache (`.cache/`) repeat runs cost
almost nothing.

## Commands

| Command                                | Output                          |
|----------------------------------------|---------------------------------|
| `npm run scrape`                       | `output/round.json`             |
| `npm run dossier`                      | `output/round-dossier.json`     |
| `npm run enrich`                       | `output/round-enriched.json`    |
| `npm run build -- --rows 200`          | `output/system.json` (target)   |
| `npm run build -- --hel 2 --halv 4`    | `output/system.json` (manual)   |
| `npm run all -- --rows 200`            | runs all four steps             |

The agent prints per-match progress to stdout so you can see exactly which
matches got full data and which fell back to streck-only estimates.

## What ends up in `round-enriched.json`

For every match: streck %, full home/away team dossier (form, home-vs-away
goal splits, injuries, recent results vs opponents of known rank, fixture
congestion), head-to-head over the last 10 meetings, API-Football's own
prediction, automatically-derived red/green flags, and the Dixon-Coles
output (lH, lA, P(1/X/2)) with every adjustment listed.

This is the data the "Reducering" tab in the UI renders, expandable per
match — so you can see exactly *why* the system picked the outcomes it did.
