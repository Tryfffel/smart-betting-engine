"""Klassificera annonser på org-typ och rollkategori mot config-listorna."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import yaml

from src.models import JobAd, OrgTyp, RoleBucket

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


@dataclass(frozen=True)
class Classification:
    org_typ: OrgTyp
    organisation: str  # normaliserat orgnamn (t.ex. "Stockholm" → "Stockholm kommun")
    role_bucket: RoleBucket
    matched_role: str  # vilken roll i config som matchade ("" om okänd)


@lru_cache(maxsize=1)
def _load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _orgs() -> dict:
    return _load_yaml("organisationer.yaml")


def _roller() -> dict:
    return _load_yaml("roller_a_lead.yaml")


def _exkluderingar() -> list[str]:
    return _load_yaml("exkluderingar.yaml")["exkluderade_roller"]


def _match_org(employer: str) -> tuple[OrgTyp, str]:
    """Returnera (org_typ, normaliserat_namn). Default ("okänd", employer)."""
    emp_lc = employer.lower()
    orgs = _orgs()

    # Rekryteringsbyråer först (de kan ha kommunnamn i annonsen)
    for byra in orgs.get("rekryteringsbyraer", []):
        if byra.lower() in emp_lc:
            return "rekryteringsbyra", byra

    # Region
    for region in orgs.get("regioner", []):
        if region.lower() in emp_lc:
            return "region", region
    # Specialfall: "Stockholms läns landsting" etc.
    if "läns landsting" in emp_lc or "landstinget" in emp_lc:
        return "region", employer

    # Myndighet
    for myndighet in orgs.get("myndigheter", []):
        if myndighet.lower() in emp_lc:
            return "myndighet", myndighet

    # Kommunala bolag: kommun + bolag-suffix
    for kommun in orgs.get("kommuner", []):
        k_lc = kommun.lower()
        if k_lc in emp_lc or f"{k_lc}s " in emp_lc:
            for suffix in orgs.get("kommunala_bolag_suffix", []):
                if suffix.lower() in emp_lc:
                    return "kommunalt_bolag", f"{kommun} – {employer}"
            # Vanlig kommun: "Stockholms stad", "Uppsala kommun" osv
            if "kommun" in emp_lc or " stad" in emp_lc or emp_lc == k_lc:
                return "kommun", f"{kommun} kommun"

    return "okänd", employer


def _match_role(titel: str, occupation_label: str | None) -> tuple[RoleBucket, str]:
    """Returnera (role_bucket, matched_role)."""
    haystack = " ".join(s.lower() for s in [titel, occupation_label or ""])

    # Exkluderingar har högsta prio
    for ex in _exkluderingar():
        if ex.lower() in haystack:
            return "exkluderad", ex

    roller = _roller()
    for chef in roller.get("chef", []):
        if chef.lower() in haystack:
            return "chef", chef
    for spec in roller.get("specialist", []):
        if spec.lower() in haystack:
            return "specialist", spec

    return "okänd", ""


def classify(ad: JobAd) -> Classification:
    org_typ, organisation = _match_org(ad.arbetsgivare)
    role_bucket, matched_role = _match_role(ad.titel, ad.occupation_label)
    return Classification(
        org_typ=org_typ,
        organisation=organisation,
        role_bucket=role_bucket,
        matched_role=matched_role or (ad.occupation_label or ad.titel),
    )


def keep(ad: JobAd, cls: Classification) -> bool:
    """Avgör om en annons ska gå vidare till scoring."""
    if cls.role_bucket == "exkluderad":
        return False
    # Rekryteringsbyråer släpps igenom även med okänd roll — de rekryterar
    # nästan alltid chef/specialist mot offentlig sektor.
    if cls.org_typ == "okänd":
        return False
    return True


def classify_batch(ads: Iterable[JobAd]) -> list[tuple[JobAd, Classification]]:
    out: list[tuple[JobAd, Classification]] = []
    kept = 0
    dropped_excl = 0
    dropped_unknown = 0
    for ad in ads:
        cls = classify(ad)
        if cls.role_bucket == "exkluderad":
            dropped_excl += 1
            continue
        if cls.org_typ == "okänd":
            dropped_unknown += 1
            continue
        out.append((ad, cls))
        kept += 1
    logger.info(
        "Filter: behöll %d, droppade %d exkluderade roller, %d okänd org",
        kept, dropped_excl, dropped_unknown,
    )
    return out
