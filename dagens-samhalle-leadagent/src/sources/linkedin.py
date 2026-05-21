"""Hämtar jobbannonser från LinkedIn via Anthropics web_search-tool.

Använder Claude Sonnet 4.6 som tolkar Google-sökresultat och returnerar en
strukturerad JSON-lista av jobbannonser. Kompletterar JobTech-källan med
LinkedIn-publicerade annonser (typiskt från rekryteringsbyråer).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from anthropic import Anthropic

from src.models import JobAd

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 2000
MAX_WEB_SEARCH_USES = 15  # totalt per körning

CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "config" / "linkedin_queries.yaml"

SYSTEM_PROMPT = """Du är researcher som hjälper en svensk B2B-säljare.

Din uppgift: använd web_search-verktyget för att hitta jobbannonser
publicerade på LinkedIn (linkedin.com/jobs) inom svensk offentlig sektor.

För varje träff du hittar, extrahera:
- titel (rolltitel)
- arbetsgivare (vilken organisation/byrå som rekryterar)
- plats (stad eller län)
- publicerad (ISO-datum YYYY-MM-DD; uppskatta från "X dagar sedan" om så anges)
- linkedin_url (full URL till annonsen)
- beskrivning_kort (1-2 meningar om rollen)

Filtrera bort:
- träffar äldre än angivet antal dagar
- träffar utanför Sverige
- dubbletter (samma annons flera gånger)

Svara ENDAST med en JSON-array i exakt detta format, ingen extra text eller
markdown:
[{"titel": "...", "arbetsgivare": "...", "plats": "...",
  "publicerad": "YYYY-MM-DD", "linkedin_url": "https://...",
  "beskrivning_kort": "..."}, ...]

Om inga träffar hittas, returnera tom array: []
"""


@lru_cache(maxsize=1)
def _load_queries() -> list[dict[str, str]]:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)["queries"]


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY saknas i miljön")
        _client = Anthropic(api_key=api_key)
    return _client


def _run_query(query: str, days: int, max_uses: int) -> list[dict[str, Any]]:
    client = _get_client()
    cutoff = (datetime.utcnow() - timedelta(days=days)).date().isoformat()
    user_msg = (
        f"Sök på Google efter LinkedIn-jobbannonser med följande söksträng:\n\n"
        f"{query}\n\n"
        f"Fönster: publicerade {cutoff} eller senare (de senaste {days} dagarna).\n"
        f"Land: Sverige. Returnera JSON-array enligt instruktionerna."
    )

    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            tools=[
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": max_uses,
                }
            ],
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception as e:
        logger.warning("LinkedIn-källan: web_search misslyckades för %r: %s", query, e)
        return []

    text = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()

    return _parse_json_array(text, query)


def _parse_json_array(text: str, query: str) -> list[dict[str, Any]]:
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        logger.warning("LinkedIn-källan: ingen JSON-array i svar för %r", query)
        return []
    raw = text[start : end + 1]
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            return []
        return [d for d in data if isinstance(d, dict)]
    except json.JSONDecodeError as e:
        logger.warning("LinkedIn-källan: JSON-fel för %r: %s", query, e)
        return []


def _parse_date(value: Any) -> date:
    if not value:
        return date.today()
    try:
        return datetime.fromisoformat(str(value)).date()
    except ValueError:
        return date.today()


def _to_jobad(item: dict[str, Any]) -> JobAd | None:
    titel = (item.get("titel") or "").strip()
    arbetsgivare = (item.get("arbetsgivare") or "").strip()
    url = (item.get("linkedin_url") or "").strip()
    if not titel or not arbetsgivare or not url:
        return None
    annons_id = "li:" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    return JobAd(
        annons_id=annons_id,
        source="linkedin",
        titel=titel,
        arbetsgivare=arbetsgivare,
        beskrivning=(item.get("beskrivning_kort") or "")[:2000],
        publicerad=_parse_date(item.get("publicerad")),
        sista_ansokningsdag=None,
        annons_url=url,
        kommun=item.get("plats"),
    )


def fetch_ads(days: int = 3) -> list[JobAd]:
    """Synkron — kör en sökning per query i config/linkedin_queries.yaml."""
    queries = _load_queries()
    budget = MAX_WEB_SEARCH_USES
    per_query = max(1, budget // max(1, len(queries)))
    all_ads: dict[str, JobAd] = {}

    for q in queries:
        qid = q["id"]
        qstr = q["query"]
        logger.info("LinkedIn-källan: kör query %s", qid)
        items = _run_query(qstr, days=days, max_uses=per_query)
        for item in items:
            ad = _to_jobad(item)
            if ad is None:
                continue
            all_ads.setdefault(ad.annons_id, ad)

    logger.info("LinkedIn-källan: %d unika annonser hittade", len(all_ads))
    return list(all_ads.values())
