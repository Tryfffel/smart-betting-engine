"""A/B/C-klassning av leads via Claude Haiku 4.5."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from anthropic import Anthropic
from pydantic import BaseModel, ValidationError

from src.filter import Classification
from src.models import JobAd, Score

logger = logging.getLogger(__name__)

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 300

SYSTEM_PROMPT = """Du är säljanalytiker på Dagens Samhälle.

Dagens Samhälle är en nyhetstjänst för svensk offentlig sektor. Vi säljer
platsannonser i tidningen och på dagenssamhalle.se/lediga-jobb. Räckvidd:
125 000 läsare/vecka enligt Kantar Sifo 2024 — främst chefer, beslutsfattare
och tjänstemän i kommuner, regioner och statliga myndigheter.

Prisbild (kronor):
- Digital annons: 12 400
- Print: från 12 400
- Sociala medier: 10 000
- Native: 29 900
- Banner: 14 900
- Tillägg DN/DI/AH/DM: från 19 900

Ditt jobb: klassa en jobbannons som A, B eller C utifrån sannolikheten att
organisationen är intresserad av att köpa en platsannons hos oss.

A = Chef ELLER kvalificerad specialist hos en mål-organisation (kommun,
    region, myndighet, kommunalt bolag, eller rekryteringsbyrå mot offentlig
    sektor). Hög köpsannolikhet. Exempel: kommundirektör, HR-chef, controller
    hos Stockholms stad; VD för kommunalt bostadsbolag; konsultchef-uppdrag
    på Mercuri Urval.
B = Relevant men lägre prio (handläggare/koordinator i mål-org, eller mer
    junior roll). Värt att kontakta vid lugn period.
C = Tekniskt matchar men låg affärspotential. T.ex. tidsbegränsade vikariat,
    visstidsuppdrag, eller mycket smala roller.

Svara ENDAST med ett JSON-objekt i exakt detta format, ingen extra text:
{"score": "A", "motivering": "Kort motivering på svenska, 1-2 meningar."}
"""


class _ScoreResponse(BaseModel):
    score: Score
    motivering: str


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY saknas i miljön")
        _client = Anthropic(api_key=api_key)
    return _client


def _build_user_message(ad: JobAd, cls: Classification) -> str:
    return (
        f"Annons:\n"
        f"- Titel: {ad.titel}\n"
        f"- Arbetsgivare: {ad.arbetsgivare}\n"
        f"- Org-typ (förklassad): {cls.org_typ}\n"
        f"- Rollkategori (förklassad): {cls.role_bucket}\n"
        f"- Matchad roll: {cls.matched_role}\n"
        f"- Plats: {ad.kommun or ''} {ad.region or ''}\n"
        f"- Publicerad: {ad.publicerad.isoformat()}\n"
        f"- Sista ansökan: {ad.sista_ansokningsdag.isoformat() if ad.sista_ansokningsdag else 'okänt'}\n"
        f"- Källa: {ad.source}\n"
        f"- Beskrivning (utdrag): {ad.beskrivning[:400]}\n"
    )


def score_lead(ad: JobAd, cls: Classification) -> _ScoreResponse:
    """Anropa Haiku med prompt-caching på system-blocket."""
    client = _get_client()
    user_msg = _build_user_message(ad, cls)
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=[
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception as e:
        logger.warning("Haiku-anrop misslyckades för %s: %s", ad.annons_id, e)
        return _ScoreResponse(score="C", motivering=f"Scoring misslyckades: {e}")

    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
    return _parse_response(text, ad.annons_id)


def _parse_response(text: str, ad_id: str) -> _ScoreResponse:
    # Plocka ut första JSON-objektet om modellen lagt till extra prosa.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        logger.warning("Ingen JSON i Haiku-svar för %s: %r", ad_id, text[:200])
        return _ScoreResponse(score="C", motivering="Kunde ej tolka modellsvar.")
    raw = text[start : end + 1]
    try:
        data: Any = json.loads(raw)
        return _ScoreResponse.model_validate(data)
    except (json.JSONDecodeError, ValidationError) as e:
        logger.warning("JSON-fel för %s: %s — råtext: %r", ad_id, e, raw[:200])
        return _ScoreResponse(score="C", motivering="Kunde ej tolka modellsvar.")


def score_batch(ads_with_cls: list[tuple[JobAd, Classification]]) -> list[tuple[JobAd, Classification, _ScoreResponse]]:
    out = []
    for i, (ad, cls) in enumerate(ads_with_cls, start=1):
        result = score_lead(ad, cls)
        out.append((ad, cls, result))
        if i % 25 == 0:
            logger.info("Scoring: %d / %d klart", i, len(ads_with_cls))
    return out


__all__ = ["score_lead", "score_batch", "_ScoreResponse"]
