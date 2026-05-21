"""SQLite-lagring: dedupera mot tidigare körningar och bevara historik."""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Iterable

from src.models import Contact, JobAd, Lead

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "leads.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    annons_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    score TEXT NOT NULL,
    organisation TEXT NOT NULL,
    org_typ TEXT NOT NULL,
    roll TEXT NOT NULL,
    role_bucket TEXT NOT NULL,
    publicerad TEXT NOT NULL,
    sista_ansokningsdag TEXT,
    ansvarig_rekryterare TEXT,
    annons_url TEXT NOT NULL,
    beskrivning TEXT,
    motivering TEXT,
    kontakt_json TEXT,
    linkedin_finns INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ny',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score);
CREATE INDEX IF NOT EXISTS idx_leads_publicerad ON leads(publicerad);

CREATE TABLE IF NOT EXISTS runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    days INTEGER NOT NULL,
    ads_fetched INTEGER NOT NULL,
    ads_new INTEGER NOT NULL,
    a_count INTEGER NOT NULL,
    b_count INTEGER NOT NULL,
    c_count INTEGER NOT NULL,
    finished_at TEXT NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    return conn


def known_ids() -> set[str]:
    with _connect() as conn:
        rows = conn.execute("SELECT annons_id FROM leads").fetchall()
    return {r[0] for r in rows}


def filter_new(ads: Iterable[JobAd]) -> list[JobAd]:
    seen = known_ids()
    ads_list = list(ads)
    new_ads = [a for a in ads_list if a.annons_id not in seen]
    logger.info("Dedup: %d nya / %d totalt", len(new_ads), len(ads_list))
    return new_ads


def upsert_leads(leads: Iterable[Lead]) -> None:
    now = datetime.utcnow().isoformat()
    rows = []
    for l in leads:
        rows.append(
            (
                l.annons_id, l.source, l.score, l.organisation, l.org_typ,
                l.roll, l.role_bucket, l.publicerad.isoformat(),
                l.sista_ansokningsdag.isoformat() if l.sista_ansokningsdag else None,
                l.ansvarig_rekryterare, l.annons_url, l.beskrivning, l.motivering,
                json.dumps(l.kontakt.model_dump(), ensure_ascii=False),
                1 if l.linkedin_finns else 0,
                l.status, now, now,
            )
        )
    with _connect() as conn:
        conn.executemany(
            """
            INSERT INTO leads (
                annons_id, source, score, organisation, org_typ, roll, role_bucket,
                publicerad, sista_ansokningsdag, ansvarig_rekryterare, annons_url,
                beskrivning, motivering, kontakt_json, linkedin_finns, status,
                first_seen, last_seen
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(annons_id) DO UPDATE SET
                score=excluded.score,
                motivering=excluded.motivering,
                kontakt_json=excluded.kontakt_json,
                linkedin_finns=excluded.linkedin_finns,
                status=excluded.status,
                last_seen=excluded.last_seen
            """,
            rows,
        )
        conn.commit()


def record_run(run_date: date, days: int, fetched: int, new: int,
               a: int, b: int, c: int) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO runs (run_date, days, ads_fetched, ads_new, a_count, b_count, c_count, finished_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (run_date.isoformat(), days, fetched, new, a, b, c, datetime.utcnow().isoformat()),
        )
        conn.commit()


def load_leads_for_date(d: date) -> list[Lead]:
    """Återskapa Lead-objekt från DB för en given publicerad-dag (för export)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT annons_id, source, score, organisation, org_typ, roll, role_bucket, "
            "publicerad, sista_ansokningsdag, ansvarig_rekryterare, annons_url, "
            "beskrivning, motivering, kontakt_json, linkedin_finns, status, first_seen, last_seen "
            "FROM leads WHERE publicerad = ?",
            (d.isoformat(),),
        ).fetchall()
    return [_row_to_lead(r) for r in rows]


def stats() -> dict:
    with _connect() as conn:
        totals = conn.execute("SELECT score, COUNT(*) FROM leads GROUP BY score").fetchall()
        runs = conn.execute(
            "SELECT run_date, ads_fetched, ads_new, a_count, b_count, c_count "
            "FROM runs ORDER BY run_id DESC LIMIT 10"
        ).fetchall()
    return {
        "totals": {s: c for s, c in totals},
        "last_runs": [
            {"datum": r[0], "hämtade": r[1], "nya": r[2], "A": r[3], "B": r[4], "C": r[5]}
            for r in runs
        ],
    }


def _row_to_lead(r: tuple) -> Lead:
    kontakt_data = json.loads(r[13]) if r[13] else {}
    return Lead(
        annons_id=r[0], source=r[1], score=r[2], organisation=r[3], org_typ=r[4],
        roll=r[5], role_bucket=r[6],
        publicerad=date.fromisoformat(r[7]),
        sista_ansokningsdag=date.fromisoformat(r[8]) if r[8] else None,
        ansvarig_rekryterare=r[9], annons_url=r[10],
        beskrivning=r[11] or "", motivering=r[12] or "",
        kontakt=Contact(**kontakt_data),
        linkedin_finns=bool(r[14]), status=r[15],
        first_seen=datetime.fromisoformat(r[16]),
        last_seen=datetime.fromisoformat(r[17]),
    )
