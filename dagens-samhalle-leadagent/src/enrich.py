"""Berikar A-leads med kontaktperson via Anthropics web_search-tool."""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from typing import Any

from anthropic import Anthropic

from src.models import Contact, Lead

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 800
MAX_USES_PER_LEAD = 5

SYSTEM_PROMPT = """Du är researcher som hjälper en svensk B2B-säljare.

Din uppgift: hitta rätt kontaktperson på en svensk organisation som
publicerat en jobbannons. Prioritetsordning:
1. HR-chef / personalchef
2. Kommunikationschef / informationschef
3. Den i annonsen angivna rekryteraren
4. Förvaltningschef eller motsvarande

Använd web_search för att söka på organisationens hemsida, LinkedIn-profiler
(via "site:linkedin.com/in/"), och pressmaterial.

Svara ENDAST med ett JSON-objekt i exakt detta format, ingen extra text:
{"namn": "...", "titel": "...", "email": "...", "kalla": "URL där info hittades"}

Om du inte hittar något användbart, svara med tomma fält:
{"namn": null, "titel": null, "email": null, "kalla": null}

Gissa aldrig email-adresser. Skriv bara email om du verifierat den från en
trovärdig källa (organisationens hemsida, presskontakt-sida).
"""


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY saknas i miljön")
        _client = Anthropic(api_key=api_key)
    return _client


@lru_cache(maxsize=512)
def _find_for_org(organisation: str, org_typ: str) -> Contact:
    """Cache:as på orgnamn så samma kommun inte sökes två gånger per körning."""
    client = _get_client()
    user_msg = (
        f"Hitta kontaktperson på följande svenska organisation:\n"
        f"- Namn: {organisation}\n"
        f"- Typ: {org_typ}\n\n"
        f"Sök primärt efter HR-chef eller kommunikationschef. "
        f"Returnera JSON-objekt enligt instruktionerna."
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
                    "max_uses": MAX_USES_PER_LEAD,
                }
            ],
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception as e:
        logger.warning("Enrich misslyckades för %s: %s", organisation, e)
        return Contact()

    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
    return _parse_contact(text, organisation)


def _parse_contact(text: str, organisation: str) -> Contact:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        logger.warning("Enrich: ingen JSON för %s", organisation)
        return Contact()
    raw = text[start : end + 1]
    try:
        data: Any = json.loads(raw)
        return Contact(
            namn=_nullable_str(data.get("namn")),
            titel=_nullable_str(data.get("titel")),
            email=_nullable_str(data.get("email")),
            kalla=_nullable_str(data.get("kalla")),
        )
    except json.JSONDecodeError as e:
        logger.warning("Enrich JSON-fel för %s: %s", organisation, e)
        return Contact()


def _nullable_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def enrich_a_leads(leads: list[Lead]) -> None:
    """Mutera A-leads in place med funnen kontaktperson."""
    a_leads = [l for l in leads if l.score == "A"]
    logger.info("Enrich: söker kontakt för %d A-leads", len(a_leads))
    for i, lead in enumerate(a_leads, start=1):
        contact = _find_for_org(lead.organisation, lead.org_typ)
        lead.kontakt = contact
        if i % 5 == 0:
            logger.info("Enrich: %d / %d klart", i, len(a_leads))
