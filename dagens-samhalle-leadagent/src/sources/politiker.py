"""Politiker-källa: kommunstyrelseordförande, regionstyrelseordförande och
övriga toppolitiker som Bonnier-säljarna ska kunna kontakta.

Politiker rekryteras inte via platsannons utan via valprocess. Källkedjan här
är därför annorlunda mot jobtech/linkedin/indeed:

  1. **Wikidata SPARQL** – primär. Hämtar P39 (uppdrag) = Q-id för KSO/RSO
     med P582 (slutdatum) = NULL och P108/P361 = svensk kommun/region.
     Open data, ingen nyckel krävs.
  2. **`config/politiker_seed.yaml`** – fallback. Manuellt verifierad lista
     med toppen-20 kommuner + alla 21 regioner. Används om Wikidata ger 0
     träffar för en kommun, eller om SPARQL-tjänsten är nere.

Eftersom politiker-uppdrag är långa (4-årig mandatperiod) hämtas de inte
varje körning utan cachas i `data/politiker_cache.json` med 7 dagars TTL.

PoC-status: SPARQL-frågan är skriven men inte testad mot Wikidata från
sandboxen (403 mot query.wikidata.org). Verifiering måste ske lokalt:

    uv run python -c "from src.sources.politiker import fetch_kso; \
        from pprint import pprint; pprint(fetch_kso()[:5])"
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx
import yaml

from src.models import JobAd

log = logging.getLogger(__name__)

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
CACHE_PATH = Path("data/politiker_cache.json")
CACHE_TTL_DAYS = 7
SEED_PATH = Path("config/politiker_seed.yaml")

# Wikidata Q-id:n
Q_KSO = "Q22808493"      # kommunstyrelsens ordförande
Q_RSO = "Q108541663"     # regionstyrelsens ordförande (verifiera ID lokalt!)
Q_SWEDISH_MUNICIPALITY = "Q127448"
Q_SWEDISH_REGION = "Q1907114"

SPARQL_QUERY_KSO = """
SELECT ?person ?personLabel ?kommun ?kommunLabel ?startdatum WHERE {
  ?person p:P39 ?uppdrag .
  ?uppdrag ps:P39 wd:%(q_kso)s .
  ?uppdrag pq:P108|pq:P642 ?kommun .
  ?kommun wdt:P31 wd:%(q_kommun)s .
  FILTER NOT EXISTS { ?uppdrag pq:P582 ?slutdatum }
  OPTIONAL { ?uppdrag pq:P580 ?startdatum }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "sv" }
}
LIMIT 500
""" % {"q_kso": Q_KSO, "q_kommun": Q_SWEDISH_MUNICIPALITY}


def _load_cache() -> Optional[list[dict]]:
    if not CACHE_PATH.exists():
        return None
    try:
        with CACHE_PATH.open() as f:
            data = json.load(f)
        cached_at = datetime.fromisoformat(data["cached_at"])
        if datetime.utcnow() - cached_at > timedelta(days=CACHE_TTL_DAYS):
            log.info("politiker-cache är äldre än %d dagar, hämtar nytt", CACHE_TTL_DAYS)
            return None
        return data["politiker"]
    except (KeyError, ValueError, json.JSONDecodeError):
        log.warning("politiker-cache trasig, hämtar nytt")
        return None


def _save_cache(politiker: list[dict]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_PATH.open("w") as f:
        json.dump({"cached_at": datetime.utcnow().isoformat(), "politiker": politiker}, f, ensure_ascii=False, indent=2)


def _query_wikidata(query: str) -> list[dict]:
    """Kör SPARQL-fråga mot Wikidata. Returnerar `bindings`-listan."""
    try:
        with httpx.Client(timeout=30.0, headers={"User-Agent": "dagens-samhalle-leadagent/0.1 (david@informa.se)"}) as client:
            resp = client.get(WIKIDATA_SPARQL, params={"query": query, "format": "json"})
            resp.raise_for_status()
            return resp.json()["results"]["bindings"]
    except (httpx.HTTPError, KeyError) as exc:
        log.warning("Wikidata SPARQL misslyckades: %s — faller tillbaka på seed", exc)
        return []


def _load_seed() -> list[dict]:
    """Läs den manuellt verifierade fallback-listan."""
    if not SEED_PATH.exists():
        return []
    with SEED_PATH.open() as f:
        data = yaml.safe_load(f) or {}

    politiker = []
    for entry in data.get("kommun_kso", []):
        if entry.get("namn") == "TBD":
            continue
        politiker.append({
            "namn": entry["namn"],
            "kommun_eller_region": entry["kommun"],
            "roll": "kommunstyrelseordförande",
            "org_typ": "kommun",
            "parti": entry.get("parti"),
            "kalla": "seed",
        })
    for entry in data.get("region_rso", []):
        if entry.get("namn") == "TBD":
            continue
        politiker.append({
            "namn": entry["namn"],
            "kommun_eller_region": entry["region"],
            "roll": "regionstyrelseordförande",
            "org_typ": "region",
            "parti": entry.get("parti"),
            "kalla": "seed",
        })
    return politiker


def fetch_politiker(*, use_cache: bool = True) -> list[dict]:
    """Returnerar alla aktiva KSO + RSO som dict.

    Försöker Wikidata först, faller tillbaka på seed-data om SPARQL faller
    eller ger 0 träffar. Cachear i data/politiker_cache.json i 7 dagar.
    """
    if use_cache:
        cached = _load_cache()
        if cached:
            log.info("Använder politiker-cache (%d personer)", len(cached))
            return cached

    politiker: list[dict] = []
    bindings = _query_wikidata(SPARQL_QUERY_KSO)
    for row in bindings:
        try:
            politiker.append({
                "namn": row["personLabel"]["value"],
                "kommun_eller_region": row["kommunLabel"]["value"],
                "roll": "kommunstyrelseordförande",
                "org_typ": "kommun",
                "wikidata_id": row["person"]["value"].rsplit("/", 1)[-1],
                "kalla": "wikidata",
            })
        except KeyError:
            continue

    if len(politiker) < 20:
        log.warning("Wikidata gav bara %d politiker, kompletterar med seed", len(politiker))
        seen = {(p["namn"], p["kommun_eller_region"]) for p in politiker}
        for entry in _load_seed():
            key = (entry["namn"], entry["kommun_eller_region"])
            if key not in seen:
                politiker.append(entry)

    _save_cache(politiker)
    log.info("Hämtade %d politiker (wikidata + seed)", len(politiker))
    return politiker


def fetch_ads(days: int | None = None) -> list[JobAd]:
    """Konvertera politiker till `JobAd`-objekt så de går genom samma pipeline.

    Politiker har inte "annons" – vi använder kommunens/regionens hemsida
    som annons_url-platshållare. `days`-argumentet ignoreras (politiker har
    inte publiceringsdatum), men accepteras för API-symmetri med övriga
    källor.
    """
    del days  # politiker filtreras inte på publiceringsdatum
    politiker = fetch_politiker()
    ads: list[JobAd] = []
    today = date.today()
    for p in politiker:
        org_namn = p["kommun_eller_region"]
        arbetsgivare = f"{org_namn} {'kommun' if p['org_typ'] == 'kommun' else 'region'}"
        ads.append(JobAd(
            annons_id=f"politiker:{p['org_typ']}:{org_namn.lower().replace(' ', '-')}:{p['roll']}",
            source="politiker",
            titel=f"{p['roll'].capitalize()} – {p['namn']}",
            arbetsgivare=arbetsgivare,
            beskrivning=f"{p['namn']} ({p.get('parti', 'okänt parti')}). Källa: {p['kalla']}.",
            publicerad=today,
            annons_url=p.get("wikidata_id") and f"https://www.wikidata.org/wiki/{p['wikidata_id']}" or "",
            ansvarig_rekryterare=p["namn"],
        ))
    return ads
