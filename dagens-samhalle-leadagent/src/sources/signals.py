"""Signal-källa: tidiga indikatorer på att en organisation snart behöver
rekrytera — INNAN platsannonsen läggs ut. Adresserar workshop-feedbacken:
"vi kommer in för sent i rekryteringsprocessen."

Tre typer av signaler:

1. **Pressmeddelanden** – kommuner/regioner publicerar ofta att en chef
   slutar 3–6 månader innan jobbet utannonseras.
2. **Kommunfullmäktige-protokoll** – beslut om "förvaltningsöversyn" eller
   "rekryteringsbehov" föregår ofta annonsen.
3. **LinkedIn-poster** – chefer som själva annonserar att de byter jobb.

Pipeline-flöde:

    [datakällor] ──► råtext-hämtning ──► Sonnet structured extract ──► Signal-CSV

`Signal`-objektet innehåller bara *indikation*, inte konkret annons. Säljaren
använder det som anledning att ringa upp i förebyggande syfte.

PoC-status: datahämtnings-funktionerna är stubbar (sandboxen blockerar
externa kommun-hemsidor). De ska implementeras lokalt enligt TODO-stoppar
nedan. Extraktor-pipelinen via Sonnet är komplett och kan testas mot
hårdkodade textstickprov.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

SignalType = Literal["chef_slutar", "rekryteringsbehov_beslutat", "byter_jobb", "okänd"]


class Signal(BaseModel):
    organisation: str
    signal_typ: SignalType
    detekterad_datum: date
    förväntad_roll: Optional[str] = None
    förväntad_tidpunkt: Optional[str] = None  # "snart", "Q3 2026", "okänt"
    källa_url: str
    källa_typ: Literal["pressmeddelande", "fullmäktige_protokoll", "linkedin", "nyhetsartikel", "okänd"]
    råtext_snippet: str = Field(..., max_length=500)
    konfidens: float = Field(..., ge=0.0, le=1.0)
    motivering: str = ""


@dataclass
class RawDocument:
    """Råtext från en datakälla, redo att skickas till extraktor."""
    organisation: str
    titel: str
    text: str
    url: str
    publiceringsdatum: date
    källa_typ: str


# ─── Datakällor ────────────────────────────────────────────────────────────

def fetch_press_releases(*, days: int = 14) -> list[RawDocument]:
    """Hämta pressmeddelanden från svenska kommuner och regioner.

    TODO (lokalt på Davids Mac, sandboxen blockerar externa siter):
    - Pluggbar mot **Mynewsdesk API** (https://www.mynewsdesk.com/api).
      Kräver gratis API-nyckel.
    - Som komplement: RSS-feeds från de 50 största kommunernas hemsidor.
      Lista över feeds underhålls i `config/press_feeds.yaml`.
    - Filtrera publiceringsdatum till senaste `days` dagar.

    Returnerar `RawDocument`-objekt med rå text för extraktor-steget.
    """
    log.warning("fetch_press_releases() är inte implementerad än — returnerar []")
    return []


def fetch_fullmaktige_protokoll(*, days: int = 30) -> list[RawDocument]:
    """Hämta nya kommunfullmäktige-protokoll.

    TODO: De flesta kommuner publicerar protokoll som PDF på sin hemsida.
    Lista över protokoll-URL:er underhålls i `config/protokoll_kallor.yaml`.
    Använd `pypdf2` för textextraktion.

    Alternativ källa: kommun- och regionforskningsinstitutet KEFU eller
    SKR:s Beslutspedia (kollas lokalt om de har öppen API).
    """
    log.warning("fetch_fullmaktige_protokoll() är inte implementerad än — returnerar []")
    return []


def fetch_linkedin_resignation_posts(*, days: int = 14) -> list[RawDocument]:
    """Hämta LinkedIn-poster där chefer i offentlig sektor meddelar att de
    slutar eller byter jobb.

    Implementeras via Anthropic web_search med queries som:
    - `site:linkedin.com/in "leaving" OR "lämnar" kommun OR region`
    - `site:linkedin.com/posts "tackar för X år" kommundirektör`

    Återanvänder samma web_search-uppställning som
    `src/sources/linkedin.py`. Se den filen för pattern.
    """
    log.warning("fetch_linkedin_resignation_posts() är inte implementerad än — returnerar []")
    return []


# ─── Extraktor ─────────────────────────────────────────────────────────────

EXTRACTOR_SYSTEM = """Du är en analytiker som läser texter från svenska kommuner och regioner
för att hitta TIDIGA SIGNALER på att en topproll snart behöver tillsättas.

Returnera ett JSON-objekt med dessa fält:

- signal_typ: en av "chef_slutar", "rekryteringsbehov_beslutat", "byter_jobb", "okänd"
- organisation: namn på kommun/region/myndighet
- förväntad_roll: vilken roll som ska tillsättas (om nämnd)
- förväntad_tidpunkt: ungefärlig tidpunkt ("snart", "Q3 2026", "om ett halvår", "okänt")
- råtext_snippet: max 300 tecken från originaltexten som styrker signalen
- konfidens: 0.0–1.0
- motivering: 1 mening på svenska

VIKTIGT:
- Returnera signal_typ = "okänd" om texten INTE indikerar nära förestående rekrytering.
- Räkna inte med chefer som redan är på plats, bara avgångar/byten.
- Specialroller (lärare, sjuksköterskor) räknas inte – bara senior chef eller nyckelperson.

Returnera bara JSON, inget annat."""


def extract_signal(doc: RawDocument, *, client=None) -> Signal | None:
    """Skicka råtext till Claude Sonnet och få tillbaka strukturerad signal.

    Klient injiceras för testbarhet. Hämtar från `anthropic.Anthropic()`
    om inget anges.
    """
    import json
    import os

    if client is None:
        from anthropic import Anthropic
        client = Anthropic()

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        system=EXTRACTOR_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"Källa: {doc.källa_typ}\nDatum: {doc.publiceringsdatum}\nOrganisation: {doc.organisation}\nTitel: {doc.titel}\n\nText:\n{doc.text[:4000]}"
        }],
    )

    try:
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1].lstrip("json\n")
        payload = json.loads(raw)
    except (json.JSONDecodeError, IndexError, KeyError) as exc:
        log.warning("Kunde inte parsa Sonnet-svar för %s: %s", doc.url, exc)
        return None

    if payload.get("signal_typ") == "okänd":
        return None
    if payload.get("konfidens", 0) < 0.5:
        return None

    return Signal(
        organisation=payload["organisation"],
        signal_typ=payload["signal_typ"],
        detekterad_datum=date.today(),
        förväntad_roll=payload.get("förväntad_roll"),
        förväntad_tidpunkt=payload.get("förväntad_tidpunkt"),
        källa_url=doc.url,
        källa_typ=doc.källa_typ,
        råtext_snippet=payload.get("råtext_snippet", doc.text[:300]),
        konfidens=payload["konfidens"],
        motivering=payload.get("motivering", ""),
    )


# ─── Top-level pipeline ────────────────────────────────────────────────────

def fetch_signals(*, days: int = 14) -> list[Signal]:
    """Hämta alla råkällor, extrahera signaler, returnera filtrerad lista."""
    docs = (
        fetch_press_releases(days=days)
        + fetch_fullmaktige_protokoll(days=days * 2)  # protokoll publiceras glesare
        + fetch_linkedin_resignation_posts(days=days)
    )
    log.info("Hämtade %d råkällor för signal-extraktion", len(docs))

    signals: list[Signal] = []
    for doc in docs:
        sig = extract_signal(doc)
        if sig is not None:
            signals.append(sig)

    log.info("Extraherade %d signaler från %d dokument", len(signals), len(docs))
    return signals


def write_signals_csv(signals: list[Signal], out_path) -> None:
    """Skriv signal-lista till CSV. Separat output från leads_master.xlsx
    eftersom signaler är annan affärslogik (tidig dialog, inte annonsförsäljning)."""
    import csv
    from pathlib import Path

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "detekterad_datum", "signal_typ", "organisation", "förväntad_roll",
        "förväntad_tidpunkt", "konfidens", "källa_typ", "källa_url",
        "motivering", "råtext_snippet",
    ]
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        for s in sorted(signals, key=lambda x: x.konfidens, reverse=True):
            writer.writerow({k: getattr(s, k) for k in fieldnames})
