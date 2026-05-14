"""Laddar upp en hel körnings outputs/YYYY-MM-DD/-mapp till Google Drive
via service-account-autentisering."""
from __future__ import annotations

import json
import logging
import mimetypes
import os
from datetime import date
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

OUTPUTS = Path(__file__).resolve().parent.parent / "outputs"
SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def _load_sa_info() -> dict[str, Any] | None:
    """Läs service account-JSON från env-var eller fil."""
    raw = os.environ.get("GOOGLE_SA_JSON")
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            logger.error("GOOGLE_SA_JSON är inte giltigt JSON: %s", e)
            return None
    path_str = os.environ.get("GOOGLE_SA_JSON_PATH")
    if path_str:
        path = Path(path_str).expanduser()
        if not path.exists():
            logger.error("GOOGLE_SA_JSON_PATH pekar på fil som inte finns: %s", path)
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def _get_service():
    info = _load_sa_info()
    if info is None:
        return None
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _find_child(service, parent_id: str, name: str, mime: str | None = None) -> str | None:
    q_parts = [
        f"'{parent_id}' in parents",
        f"name = '{name.replace(chr(39), chr(92) + chr(39))}'",
        "trashed = false",
    ]
    if mime:
        q_parts.append(f"mimeType = '{mime}'")
    q = " and ".join(q_parts)
    resp = service.files().list(
        q=q, fields="files(id,name)", supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    return files[0]["id"] if files else None


def _get_or_create_folder(service, parent_id: str, name: str) -> str:
    existing = _find_child(service, parent_id, name, "application/vnd.google-apps.folder")
    if existing:
        return existing
    folder = service.files().create(
        body={
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        },
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return folder["id"]


def _upload_file(service, path: Path, parent_id: str) -> None:
    from googleapiclient.http import MediaFileUpload

    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    media = MediaFileUpload(str(path), mimetype=mime, resumable=False)
    existing = _find_child(service, parent_id, path.name)
    if existing:
        service.files().update(
            fileId=existing, media_body=media, supportsAllDrives=True
        ).execute()
        logger.info("Drive: uppdaterade %s", path.name)
    else:
        service.files().create(
            body={"name": path.name, "parents": [parent_id]},
            media_body=media,
            fields="id",
            supportsAllDrives=True,
        ).execute()
        logger.info("Drive: laddade upp %s", path.name)


def upload_run(run_date: date) -> bool:
    """Ladda upp outputs/run_date/ till GOOGLE_DRIVE_FOLDER_ID/run_date/.
    Returnerar True om uppladdning skedde, False om hoppades över."""
    folder_id = os.environ.get("GOOGLE_DRIVE_FOLDER_ID")
    if not folder_id:
        logger.warning("Drive: GOOGLE_DRIVE_FOLDER_ID saknas — hoppar över upload")
        return False

    service = _get_service()
    if service is None:
        logger.warning("Drive: service account-credentials saknas — hoppar över upload")
        return False

    run_dir = OUTPUTS / run_date.isoformat()
    if not run_dir.exists():
        logger.warning("Drive: inget att ladda upp för %s", run_date)
        return False

    date_folder = _get_or_create_folder(service, folder_id, run_date.isoformat())
    a_leads_folder = _get_or_create_folder(service, date_folder, "a_leads")

    for path in run_dir.iterdir():
        if path.is_file():
            _upload_file(service, path, date_folder)
        elif path.name == "a_leads" and path.is_dir():
            for md in path.iterdir():
                if md.is_file():
                    _upload_file(service, md, a_leads_folder)

    logger.info("Drive: uppladdning klar för %s", run_date)
    return True
