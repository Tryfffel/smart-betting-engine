"""Pydantic-modeller delade av hela pipen."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

Source = Literal["jobtech", "linkedin", "indeed", "politiker", "signal"]
OrgTyp = Literal["kommun", "region", "myndighet", "kommunalt_bolag", "rekryteringsbyra", "okänd"]
RoleBucket = Literal["chef", "specialist", "politiker", "exkluderad", "okänd"]
Score = Literal["A", "B", "C"]


class JobAd(BaseModel):
    """Rå annonsdata efter normalisering från en källa."""

    annons_id: str
    source: Source
    titel: str
    arbetsgivare: str
    beskrivning: str = ""
    publicerad: date
    sista_ansokningsdag: Optional[date] = None
    annons_url: str
    ansvarig_rekryterare: Optional[str] = None
    occupation_label: Optional[str] = None  # JobTech-rollkategori
    kommun: Optional[str] = None
    region: Optional[str] = None


class Contact(BaseModel):
    namn: Optional[str] = None
    titel: Optional[str] = None
    email: Optional[str] = None
    kalla: Optional[str] = None  # URL där informationen hittades


class Lead(BaseModel):
    """En klassad, dedupad annons redo för export."""

    annons_id: str
    source: Source
    score: Score
    organisation: str
    org_typ: OrgTyp
    roll: str
    role_bucket: RoleBucket
    publicerad: date
    sista_ansokningsdag: Optional[date] = None
    ansvarig_rekryterare: Optional[str] = None
    annons_url: str
    beskrivning: str = ""
    motivering: str = ""
    kontakt: Contact = Field(default_factory=Contact)
    linkedin_finns: bool = False
    status: str = "ny"
    first_seen: datetime = Field(default_factory=datetime.utcnow)
    last_seen: datetime = Field(default_factory=datetime.utcnow)
