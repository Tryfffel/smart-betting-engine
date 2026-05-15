"""Hämtar jobbannonser från JobTech Development JobSearch API.

API-dokumentation: https://jobsearch.api.jobtechdev.se (Swagger UI på roten).
Ingen autentisering krävs för läsning. Täcker Platsbanken.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta
from typing import Any

import httpx

from src.models import JobAd

logger = logging.getLogger(__name__)

BASE_URL = "https://jobsearch.api.jobtechdev.se"
SEARCH_PATH = "/search"
PAGE_SIZE = 100
MAX_PAGES = 50  # säkerhetsbroms: 5000 träffar max per körning
RATE_LIMIT = 10  # max samtidiga requests


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _map_hit(hit: dict[str, Any]) -> JobAd | None:
    """Konvertera en JobTech-hit till en JobAd. Returnerar None om obligatoriska
    fält saknas."""
    annons_id = hit.get("id") or hit.get("external_id")
    headline = hit.get("headline")
    employer = (hit.get("employer") or {}).get("name") or (hit.get("employer") or {}).get("workplace")
    if not annons_id or not headline or not employer:
        return None

    publicerad = _parse_date(hit.get("publication_date"))
    if publicerad is None:
        publicerad = date.today()

    workplace = hit.get("workplace_address") or {}
    application_details = hit.get("application_details") or {}
    contact = (hit.get("application_contacts") or [{}])[0]

    return JobAd(
        annons_id=str(annons_id),
        source="jobtech",
        titel=headline,
        arbetsgivare=employer,
        beskrivning=((hit.get("description") or {}).get("text_formatted")
                     or (hit.get("description") or {}).get("text")
                     or "")[:2000],
        publicerad=publicerad,
        sista_ansokningsdag=_parse_date(hit.get("application_deadline")),
        annons_url=hit.get("webpage_url")
                   or application_details.get("url_direct")
                   or f"https://arbetsformedlingen.se/platsbanken/annonser/{annons_id}",
        ansvarig_rekryterare=contact.get("name") or application_details.get("reference"),
        occupation_label=(hit.get("occupation") or {}).get("label"),
        kommun=workplace.get("municipality"),
        region=workplace.get("region"),
    )


class JobTechClient:
    def __init__(self, base_url: str = BASE_URL, timeout: float = 30.0):
        self.base_url = base_url
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={"Accept": "application/json", "User-Agent": "dagens-samhalle-leadagent/0.1"},
        )
        self._sem = asyncio.Semaphore(RATE_LIMIT)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "JobTechClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def _page(self, params: dict[str, Any]) -> dict[str, Any]:
        async with self._sem:
            resp = await self._client.get(SEARCH_PATH, params=params)
            resp.raise_for_status()
            return resp.json()

    async def fetch_ads(self, days: int = 3) -> list[JobAd]:
        """Hämta alla annonser publicerade de senaste `days` dagarna."""
        published_after = (datetime.utcnow() - timedelta(days=days)).isoformat(timespec="seconds")
        ads: list[JobAd] = []
        offset = 0
        total_in_api: int | None = None
        for page in range(MAX_PAGES):
            params = {
                "published-after": published_after,
                "limit": PAGE_SIZE,
                "offset": offset,
            }
            logger.info("JobTech: hämtar sida %d (offset=%d)", page + 1, offset)
            try:
                payload = await self._page(params)
            except httpx.HTTPError as e:
                logger.error("JobTech-anrop misslyckades: %s", e)
                break

            if total_in_api is None:
                total_field = payload.get("total")
                if isinstance(total_field, dict):
                    total_in_api = total_field.get("value")
                elif isinstance(total_field, int):
                    total_in_api = total_field

            hits = payload.get("hits", [])
            if not hits:
                break

            for hit in hits:
                ad = _map_hit(hit)
                if ad is not None:
                    ads.append(ad)

            if len(hits) < PAGE_SIZE:
                break
            offset += PAGE_SIZE

        logger.info("JobTech: %d annonser hämtade (total i API: %s)", len(ads), total_in_api)
        return ads


async def fetch_ads(days: int = 3) -> list[JobAd]:
    """Bekvämlighetsfunktion: hämta annonser utan att hantera client manuellt."""
    async with JobTechClient() as client:
        return await client.fetch_ads(days=days)
