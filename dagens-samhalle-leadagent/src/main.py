"""CLI som knyter ihop hämta → filtrera → score → enrich → export → upload."""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime
from typing import Iterable

import typer
from dotenv import load_dotenv

from src import drive, enrich, export, filter as flt, score, storage
from src.models import JobAd, Lead
from src.sources import jobtech, linkedin

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("leadagent")

app = typer.Typer(help="Lead-research-agent för Dagens Samhälle", no_args_is_help=True)


def _slug(text: str) -> str:
    return re.sub(r"[^\w]+", "-", text.lower())[:80]


def _crossdedup_linkedin(jobtech_ads: list[JobAd], linkedin_ads: list[JobAd]) -> list[JobAd]:
    """Kasta LinkedIn-träffar som motsvarar en JobTech-träff (samma arbetsgivare
    + roll-substring + ±2 dagar publicerad)."""
    jt_index: dict[tuple[str, str], list[JobAd]] = {}
    for ad in jobtech_ads:
        key = (_slug(ad.arbetsgivare), _slug(ad.titel)[:30])
        jt_index.setdefault(key, []).append(ad)

    kept: list[JobAd] = []
    dropped = 0
    for li_ad in linkedin_ads:
        key = (_slug(li_ad.arbetsgivare), _slug(li_ad.titel)[:30])
        candidates = jt_index.get(key, [])
        match = any(abs((li_ad.publicerad - jt.publicerad).days) <= 2 for jt in candidates)
        if match:
            dropped += 1
            continue
        kept.append(li_ad)
    if dropped:
        logger.info("Korsdedup: kastade %d LinkedIn-träffar som matchar JobTech", dropped)
    return kept


async def _fetch_all(days: int, include_linkedin: bool) -> list[JobAd]:
    jt_task = asyncio.create_task(jobtech.fetch_ads(days=days))
    li_task = (
        asyncio.create_task(asyncio.to_thread(linkedin.fetch_ads, days))
        if include_linkedin else None
    )
    jt_ads = await jt_task
    li_ads = await li_task if li_task else []
    li_ads = _crossdedup_linkedin(jt_ads, li_ads)
    return jt_ads + li_ads


def _build_lead(ad: JobAd, cls: flt.Classification, sc: score._ScoreResponse) -> Lead:
    now = datetime.utcnow()
    return Lead(
        annons_id=ad.annons_id, source=ad.source,
        score=sc.score, organisation=cls.organisation, org_typ=cls.org_typ,
        roll=cls.matched_role, role_bucket=cls.role_bucket,
        publicerad=ad.publicerad, sista_ansokningsdag=ad.sista_ansokningsdag,
        ansvarig_rekryterare=ad.ansvarig_rekryterare, annons_url=ad.annons_url,
        beskrivning=ad.beskrivning, motivering=sc.motivering,
        linkedin_finns=(ad.source == "linkedin"),
        first_seen=now, last_seen=now,
    )


@app.command()
def run(
    days: int = typer.Option(3, help="Antal dagar bakåt att hämta annonser"),
    no_enrich: bool = typer.Option(False, "--no-enrich", help="Hoppa över kontaktperson-sökning"),
    no_upload: bool = typer.Option(False, "--no-upload", help="Hoppa över Drive-upload"),
    no_linkedin: bool = typer.Option(False, "--no-linkedin", help="Hoppa över LinkedIn-källan"),
) -> None:
    """Full körning: hämta → filtrera → score → enrich → export → upload."""
    today = date.today()
    logger.info("=== Lead-research-agent startar (days=%d) ===", days)

    ads = asyncio.run(_fetch_all(days=days, include_linkedin=not no_linkedin))
    logger.info("Hämtade %d annonser totalt", len(ads))

    new_ads = storage.filter_new(ads)
    logger.info("Efter dedup mot DB: %d nya annonser", len(new_ads))

    classified = flt.classify_batch(new_ads)
    if not classified:
        logger.info("Inga matchande annonser att skicka till scoring.")
        storage.record_run(today, days, len(ads), 0, 0, 0, 0)
        return

    logger.info("Scoring av %d annonser…", len(classified))
    scored = score.score_batch(classified)
    leads = [_build_lead(ad, cls, sc) for ad, cls, sc in scored]

    a = sum(1 for l in leads if l.score == "A")
    b = sum(1 for l in leads if l.score == "B")
    c = sum(1 for l in leads if l.score == "C")
    logger.info("Score-fördelning: A=%d B=%d C=%d", a, b, c)

    if not no_enrich:
        enrich.enrich_a_leads(leads)
    else:
        logger.info("Hoppar över enrich (--no-enrich)")

    storage.upsert_leads(leads)
    storage.record_run(today, days, len(ads), len(new_ads), a, b, c)

    run_dir = export.write_outputs(leads, today)
    logger.info("Output skrivet till %s", run_dir)

    if not no_upload:
        drive.upload_run(today)
    else:
        logger.info("Hoppar över Drive-upload (--no-upload)")

    logger.info("=== Klart ===")


@app.command()
def stats() -> None:
    """Visa DB-statistik."""
    s = storage.stats()
    typer.echo("Totalt per score:")
    for sc, n in sorted(s["totals"].items()):
        typer.echo(f"  {sc}: {n}")
    typer.echo("\nSenaste 10 körningar:")
    for r in s["last_runs"]:
        typer.echo(
            f"  {r['datum']}  hämtade={r['hämtade']:4d}  nya={r['nya']:4d}  "
            f"A={r['A']:3d}  B={r['B']:3d}  C={r['C']:3d}"
        )


@app.command()
def upload(date_str: str = typer.Argument(..., metavar="YYYY-MM-DD")) -> None:
    """Ladda upp en redan exporterad körning till Drive."""
    d = date.fromisoformat(date_str)
    leads = storage.load_leads_for_date(d)
    if leads:
        export.write_outputs(leads, d)
    ok = drive.upload_run(d)
    typer.echo("Uppladdning klar." if ok else "Uppladdning hoppades över.")


if __name__ == "__main__":
    app()
