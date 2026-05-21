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
from src.sources import indeed, jobtech, linkedin, politiker, signals

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


def _crossdedup(primary: list[JobAd], secondary: list[JobAd], label: str) -> list[JobAd]:
    """Kasta secondary-träffar som motsvarar en primary-träff (samma arbetsgivare
    + roll-substring + ±2 dagar publicerad)."""
    index: dict[tuple[str, str], list[JobAd]] = {}
    for ad in primary:
        key = (_slug(ad.arbetsgivare), _slug(ad.titel)[:30])
        index.setdefault(key, []).append(ad)

    kept: list[JobAd] = []
    dropped = 0
    for ad in secondary:
        key = (_slug(ad.arbetsgivare), _slug(ad.titel)[:30])
        candidates = index.get(key, [])
        if any(abs((ad.publicerad - p.publicerad).days) <= 2 for p in candidates):
            dropped += 1
            continue
        kept.append(ad)
    if dropped:
        logger.info("Korsdedup: kastade %d %s-träffar som matchar tidigare källa", dropped, label)
    return kept


async def _fetch_all(days: int, include_linkedin: bool, include_indeed: bool, include_politiker: bool) -> list[JobAd]:
    jt_task = asyncio.create_task(jobtech.fetch_ads(days=days))
    li_task = (
        asyncio.create_task(asyncio.to_thread(linkedin.fetch_ads, days))
        if include_linkedin else None
    )
    jt_ads = await jt_task
    li_ads = await li_task if li_task else []
    li_ads = _crossdedup(jt_ads, li_ads, "LinkedIn")

    in_ads: list[JobAd] = []
    if include_indeed:
        in_ads = indeed.fetch_ads(days=days)
        # Dedupa mot både JobTech och kvarvarande LinkedIn-träffar
        in_ads = _crossdedup(jt_ads + li_ads, in_ads, "Indeed")

    pol_ads: list[JobAd] = []
    if include_politiker:
        # Politiker har långa mandatperioder, men dedupas mot DB i nästa steg
        # så samma KSO inte rapporteras varje vecka.
        pol_ads = politiker.fetch_ads()
        logger.info("Politiker-källan: %d aktiva uppdrag", len(pol_ads))

    return jt_ads + li_ads + in_ads + pol_ads


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
    no_linkedin: bool = typer.Option(False, "--no-linkedin", help="Hoppa över LinkedIn-källan"),
    no_indeed: bool = typer.Option(False, "--no-indeed", help="Hoppa över Indeed-källan (staging-fil)"),
    no_politiker: bool = typer.Option(False, "--no-politiker", help="Hoppa över politiker-källan"),
    no_drive: bool = typer.Option(False, "--no-drive", help="Hoppa över Drive-upload"),
    no_score: bool = typer.Option(
        False, "--no-score",
        help="Kör utan Anthropic — alla leads defaultar till B. Force-ar --no-enrich och --no-linkedin.",
    ),
    signals_only: bool = typer.Option(False, "--signals-only", help="Kör bara signal-spåret (tidiga rekryterings-signaler), hoppa över lead-pipeline"),
    no_signals: bool = typer.Option(False, "--no-signals", help="Hoppa över signal-spåret efter lead-pipelinen"),
) -> None:
    """Lokal pipeline: hämta → filtrera → score → enrich → export → drive."""
    if no_score:
        no_enrich = True
        no_linkedin = True
        logger.info("No-AI-mode: --no-score → tvingar --no-enrich + --no-linkedin")
    today = date.today()

    if signals_only:
        logger.info("=== Signal-spår (--signals-only) ===")
        sigs = signals.fetch_signals(days=days * 5)  # signaler får bredare fönster
        out_path = export.signals_csv_path(today)
        signals.write_signals_csv(sigs, out_path)
        logger.info("Skrev %d signaler till %s", len(sigs), out_path)
        return

    logger.info("=== Lead-research-agent startar (days=%d) ===", days)

    ads = asyncio.run(_fetch_all(
        days=days,
        include_linkedin=not no_linkedin,
        include_indeed=not no_indeed,
        include_politiker=not no_politiker,
    ))
    logger.info("Hämtade %d annonser totalt", len(ads))

    new_ads = storage.filter_new(ads)
    logger.info("Efter dedup mot DB: %d nya annonser", len(new_ads))

    classified = flt.classify_batch(new_ads)
    if not classified:
        logger.info("Inga matchande annonser att skicka till scoring.")
        storage.record_run(today, days, len(ads), 0, 0, 0, 0)
        return

    if no_score:
        logger.info("Hoppar över scoring (--no-score) — alla leads defaultar till B")
        stub = score._ScoreResponse(score="B", motivering="(no-AI mode — ej scorad)")
        leads = [_build_lead(ad, cls, stub) for ad, cls in classified]
    else:
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

    if not no_signals:
        logger.info("Kör signal-spåret (tidiga rekryteringssignaler)…")
        try:
            sigs = signals.fetch_signals(days=days * 5)
            signals.write_signals_csv(sigs, export.signals_csv_path(today))
            logger.info("Skrev %d signaler till signals.csv", len(sigs))
        except Exception as exc:  # noqa: BLE001 - inte fatalt
            logger.warning("Signal-spåret failade: %s — fortsätter ändå", exc)

    if no_drive:
        logger.info("Hoppar över Drive-upload (--no-drive)")
    else:
        try:
            link = drive.upload_run(run_dir, today)
            logger.info("Drive-mapp: %s", link)
        except Exception:
            logger.exception("Drive-upload misslyckades")
            raise

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
def rebuild(date_str: str = typer.Argument(..., metavar="YYYY-MM-DD")) -> None:
    """Återskapa outputs/YYYY-MM-DD/ från DB:n (utan att köra hela pipelinen).

    Användbart om man behöver ladda upp en gammal körning till Drive igen
    eller om export-formatet har ändrats."""
    d = date.fromisoformat(date_str)
    leads = storage.load_leads_for_date(d)
    if not leads:
        typer.echo(f"Inga leads i DB:n för {d}")
        raise typer.Exit(1)
    run_dir = export.write_outputs(leads, d)
    typer.echo(f"Återskapade {len(leads)} leads till {run_dir}")


if __name__ == "__main__":
    app()
