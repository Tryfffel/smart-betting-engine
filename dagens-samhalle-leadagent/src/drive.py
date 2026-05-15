"""Ladda upp outputs/YYYY-MM-DD/ till Google Drive via service account.

Schemalagda körningar (launchd) har inte tillgång till MCP, så den här
modulen körs som en del av pipelinens slutsteg när --no-drive inte är satt.
Manuella körningar via Claude Code kan fortfarande använda MCP-vägen som
beskrivs i RUNBOOK.md.
"""
from __future__ import annotations

import logging
import os
from datetime import date
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
FOLDER_MIME = "application/vnd.google-apps.folder"

MIME_BY_SUFFIX = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".md": "text/markdown",
}


def _service():
    key_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not key_path:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON saknas i .env")
    creds = service_account.Credentials.from_service_account_file(key_path, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _find_or_create_folder(svc, name: str, parent_id: str) -> str:
    q = (
        f"name = '{name}' and '{parent_id}' in parents "
        f"and mimeType = '{FOLDER_MIME}' and trashed = false"
    )
    resp = svc.files().list(
        q=q, fields="files(id)", supportsAllDrives=True, includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    if files:
        return files[0]["id"]
    meta = {"name": name, "mimeType": FOLDER_MIME, "parents": [parent_id]}
    created = svc.files().create(body=meta, fields="id", supportsAllDrives=True).execute()
    return created["id"]


def _upload_file(svc, path: Path, parent_id: str) -> str:
    mime = MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
    media = MediaFileUpload(str(path), mimetype=mime, resumable=False)
    q = (
        f"name = '{path.name}' and '{parent_id}' in parents and trashed = false"
    )
    existing = svc.files().list(
        q=q, fields="files(id)", supportsAllDrives=True, includeItemsFromAllDrives=True,
    ).execute().get("files", [])
    if existing:
        file_id = existing[0]["id"]
        svc.files().update(fileId=file_id, media_body=media, supportsAllDrives=True).execute()
        return file_id
    meta = {"name": path.name, "parents": [parent_id]}
    created = svc.files().create(
        body=meta, media_body=media, fields="id", supportsAllDrives=True,
    ).execute()
    return created["id"]


def upload_run(run_dir: Path, run_date: date) -> str:
    """Ladda upp samtliga filer under run_dir till en YYYY-MM-DD-undermapp.

    Returnerar Drive-länken till datum-mappen.
    """
    root = os.environ.get("DRIVE_FOLDER_ID")
    if not root:
        raise RuntimeError("DRIVE_FOLDER_ID saknas i .env")
    if not run_dir.exists():
        raise FileNotFoundError(f"Run-dir saknas: {run_dir}")

    svc = _service()
    date_folder = _find_or_create_folder(svc, run_date.isoformat(), root)

    n = 0
    for entry in sorted(run_dir.iterdir()):
        if entry.is_dir():
            sub_id = _find_or_create_folder(svc, entry.name, date_folder)
            for f in sorted(entry.iterdir()):
                if f.is_file():
                    _upload_file(svc, f, sub_id)
                    n += 1
        elif entry.is_file():
            _upload_file(svc, entry, date_folder)
            n += 1

    link = f"https://drive.google.com/drive/folders/{date_folder}"
    logger.info("Drive: laddade upp %d filer till %s", n, link)
    return link
