from __future__ import annotations

import json
import logging
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional


logger = logging.getLogger(__name__)


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def json_dump(path: Path, payload: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def json_load(path: Path) -> Dict:
    return json.loads(path.read_text(encoding="utf-8"))


def chunked(items: Iterable, size: int) -> Iterator[List]:
    bucket: List = []
    for item in items:
        bucket.append(item)
        if len(bucket) >= size:
            yield bucket
            bucket = []
    if bucket:
        yield bucket


def safe_stem(name: str) -> str:
    return Path(name).stem.replace(" ", "_")


def job_dir(root: Path, prefix: str = "job") -> Path:
    return ensure_dir(root / f"{prefix}-{uuid.uuid4().hex}")


@contextmanager
def managed_workdir(path: Path, keep: bool = False) -> Iterator[Path]:
    ensure_dir(path)
    try:
        yield path
    finally:
        if not keep:
            shutil.rmtree(path, ignore_errors=True)


@contextmanager
def temp_download_dir(prefix: str = "pathassist-model-") -> Iterator[Path]:
    temp_dir = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def resolve_first_file(paths: Iterable[Path], suffixes: Optional[Iterable[str]] = None) -> Optional[Path]:
    suffix_set = {s.lower() for s in suffixes or []}
    for path in paths:
        if not path.exists():
            continue
        if not suffix_set or path.suffix.lower() in suffix_set:
            return path
    return None
