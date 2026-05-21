"""Läser Indeed-jobbannonser från en JSON-staging-fil.

Eftersom Indeed nås via en MCP-server som bara är tillgänglig från Claude
Code-sessionen kan inte Python själv anropa den. Istället:

1. Claude Code anropar MCP `search_jobs` för varje fras i
   `config/indeed_queries.yaml` (se RUNBOOK.md).
2. Claude Code skriver träffarna som en lista av dict till
   `/tmp/leadagent_indeed.json` (eller annan path via INDEED_JSON env-var).
3. Den här modulen läser filen och konverterar till JobAd-objekt.

Förväntat JSON-format (samma som returnerat av MCP search_jobs efter parse):
[
  {"job_id": "JOB_123", "title": "...", "company": "...",
   "location": "...", "posted_on": "April 28, 2026",
   "apply_url": "https://to.indeed.com/...",
   "description": "valfritt utdrag"},
  ...
]
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from src.models import JobAd

logger = logging.getLogger(__name__)

DEFAULT_JSON_PATH = Path("/tmp/leadagent_indeed.json")
MAX_AGE_HOURS = 6


def _resolve_path() -> Path:
    path_str = os.environ.get("INDEED_JSON")
    return Path(path_str) if path_str else DEFAULT_JSON_PATH


def _parse_posted_on(value: Any) -> date:
    """Parse Indeeds 'April 28, 2026' eller ISO-datum."""
    if not value:
        return date.today()
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s).date()
    except ValueError:
        return date.today()


def _to_jobad(item: dict[str, Any]) -> JobAd | None:
    title = (item.get("title") or item.get("Job Title") or "").strip()
    company = (item.get("company") or item.get("Company") or "").strip()
    url = (item.get("apply_url") or item.get("View Job URL") or "").strip()
    job_id_raw = (item.get("job_id") or item.get("Job Id") or url or title).strip()
    if not title or not company or not url:
        return None
    annons_id = "indeed:" + hashlib.sha1(job_id_raw.encode("utf-8")).hexdigest()[:12]
    return JobAd(
        annons_id=annons_id,
        source="indeed",
        titel=title,
        arbetsgivare=company,
        beskrivning=(item.get("description") or "")[:2000],
        publicerad=_parse_posted_on(item.get("posted_on") or item.get("Posted on")),
        sista_ansokningsdag=None,
        annons_url=url,
        kommun=item.get("location") or item.get("Location"),
    )


def fetch_ads(days: int = 3) -> list[JobAd]:
    """Läs staging-filen och returnera JobAd-objekt. Returnerar tom lista om
    filen saknas eller är för gammal."""
    path = _resolve_path()
    if not path.exists():
        logger.info("Indeed-källan: ingen staging-fil på %s — hoppar över", path)
        return []
    age = datetime.now() - datetime.fromtimestamp(path.stat().st_mtime)
    if age > timedelta(hours=MAX_AGE_HOURS):
        logger.warning("Indeed-källan: staging-fil äldre än %d h (%s) — hoppar över",
                       MAX_AGE_HOURS, age)
        return []

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        logger.error("Indeed-källan: JSON-fel i %s: %s", path, e)
        return []
    if not isinstance(data, list):
        logger.error("Indeed-källan: förväntade JSON-array, fick %s", type(data).__name__)
        return []

    cutoff = date.today() - timedelta(days=days)
    ads: dict[str, JobAd] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        ad = _to_jobad(item)
        if ad is None:
            continue
        if ad.publicerad < cutoff:
            continue
        ads.setdefault(ad.annons_id, ad)

    logger.info("Indeed-källan: %d annonser inlästa från %s", len(ads), path)
    return list(ads.values())
