from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List, Optional

from girder_client import GirderClient

from .config import Settings


logger = logging.getLogger(__name__)


class GirderService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = GirderClient(apiUrl=settings.girder_api_url)
        self._authenticate()

    def _authenticate(self) -> None:
        if self.settings.girder_token:
            self.client.setToken(self.settings.girder_token)
            return
        if self.settings.girder_api_key:
            self.client.authenticate(apiKey=self.settings.girder_api_key)
            return
        if self.settings.girder_username and self.settings.girder_password:
            self.client.authenticate(
                username=self.settings.girder_username,
                password=self.settings.girder_password,
            )
            return
        raise RuntimeError("Girder credentials are not configured.")

    def get_item(self, item_id: str) -> Dict:
        return self.client.get(f"item/{item_id}")

    def get_folder(self, folder_id: str) -> Dict:
        return self.client.get(f"folder/{folder_id}")

    def get_file_for_item(self, item_id: str) -> Dict:
        files = self.client.get(f"item/{item_id}/files", parameters={"limit": 10})
        if not files:
            raise RuntimeError(f"No files found for item {item_id}")
        return files[0]

    def get_tiles_info(self, item_id: str) -> Optional[Dict]:
        try:
            return self.client.get(f"item/{item_id}/tiles")
        except Exception as exc:  # pragma: no cover - network specific
            logger.warning("Failed to fetch tile metadata for %s: %s", item_id, exc)
            return None

    def download_item_file(self, item_id: str, dest_dir: Path) -> Path:
        file_doc = self.get_file_for_item(item_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        self.client.downloadFile(file_doc["_id"], str(dest_dir))
        path = dest_dir / file_doc["name"]
        if not path.exists():
            raise RuntimeError(f"Expected downloaded file missing: {path}")
        return path

    def create_annotation(self, item_id: str, annotation_doc: Dict) -> Dict:
        return self.client.post(f"annotation?itemId={item_id}", data=annotation_doc)

    def upload_file_to_folder(self, folder_id: str, file_path: Path, mime_type: str = "application/json") -> Dict:
        return self.client.uploadFileToFolder(
            folder_id,
            str(file_path),
            mimeType=mime_type,
        )

    def update_item_metadata(self, item_id: str, metadata: Dict) -> Dict:
        return self.client.put(f"item/{item_id}/metadata", data=metadata)

    def get_assetstore(self, assetstore_id: str) -> Dict:
        return self.client.get(f"assetstore/{assetstore_id}")

    def set_job_status(self, job_id: str, status: int, log: Optional[str] = None) -> Dict:
        payload = {"status": status}
        if log:
            payload["log"] = log
        return self.client.put(f"job/{job_id}", data=payload)
