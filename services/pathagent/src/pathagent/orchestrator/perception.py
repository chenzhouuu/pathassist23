"""Gateway-side runner for the CONCH concept-similarity perception subprocess.

The heavy step needs torch + conch, which live only in the pathology conda env,
so it runs as a self-contained subprocess (:mod:`perception_subprocess`)
launched with ``settings.trident_python`` — mirroring
:mod:`pathagent.worker.trident_runner`. Communication is JSON on stdin/stdout.
"""

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..common.cache_keys import cache_paths
from ..common.config import Settings
from . import heatmap
from .concepts import DIAGNOSTIC_CONCEPTS
from .kb import load_seed_kb

logger = logging.getLogger(__name__)

_REQUIRED_KEYS = ("regions", "rasterExtent", "gridShape", "kbHits")


@dataclass(frozen=True)
class NavResult:
    """Result of one concept-similarity perception pass over a case."""

    regions: list[dict]
    raster_extent: dict
    grid_shape: list[int]
    kb_hits: list[dict]


class PerceptionError(RuntimeError):
    """Raised when the perception subprocess fails or returns an unusable result."""


def _subprocess_env() -> dict[str, str]:
    """Copy the environment, mirroring the HF token across both variable names."""
    env = os.environ.copy()
    tok = env.get("HF_TOKEN") or env.get("HUGGING_FACE_HUB_TOKEN")
    if tok:
        env["HF_TOKEN"] = tok
        env["HUGGING_FACE_HUB_TOKEN"] = tok
    return env


def _stderr_tail(stderr: str | bytes | None, limit: int = 2000) -> str:
    """Return the trailing ``limit`` chars of subprocess stderr for error context."""
    if stderr is None:
        return ""
    if isinstance(stderr, bytes):
        stderr = stderr.decode(errors="replace")
    return stderr[-limit:]


class PerceptionRunner:
    """Launch the CONCH perception subprocess and marshal its JSON result."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._script = Path(__file__).parent / "perception_subprocess.py"

    def run(self, cache_key: str, question: str, task_id: str,
            roi: dict | None = None) -> NavResult:
        """Run concept-similarity perception for one case + question.

        Args:
            cache_key: Preprocessed-case cache key (locates the features h5).
            question: Free-text clinical question to condition importance on.
            task_id: Unique id for this pass (names the heatmap PNG + meta).
            roi: Optional level-0 ``{x, y, width, height}`` rectangle to restrict to.

        Returns:
            A :class:`NavResult` with hotspot/coverage regions, the raster
            extent, grid shape, and top KB hits.

        Raises:
            PerceptionError: If features are missing, the subprocess fails or
                times out, or its output cannot be parsed/validated.
        """
        settings = self._settings
        paths = cache_paths(cache_key)
        features = paths.features(settings.navigation_encoder)
        if not features.is_file():
            raise PerceptionError(f"features not found: {features}")
        paths.heatmap(task_id).parent.mkdir(parents=True, exist_ok=True)

        request = {
            "featuresH5": str(features),
            "question": question,
            "concepts": DIAGNOSTIC_CONCEPTS,
            "navTopK": settings.nav_top_k,
            "kbSnippets": load_seed_kb(),
            "kbTopK": settings.kb_top_k,
            "rasterPng": str(paths.heatmap(task_id)),
            "roi": roi,
        }
        proc = self._launch(request)
        result = self._parse(proc.stdout)
        try:
            heatmap.write_meta(paths.heatmap_meta(task_id), result["rasterExtent"])
            return NavResult(
                regions=result["regions"],
                raster_extent=result["rasterExtent"],
                grid_shape=result["gridShape"],
                kb_hits=result["kbHits"],
            )
        except (KeyError, TypeError) as exc:
            raise PerceptionError(f"perception result malformed: {exc}") from exc

    def _launch(self, request: dict) -> subprocess.CompletedProcess:
        """Run the subprocess; raise :class:`PerceptionError` on timeout/non-zero exit."""
        settings = self._settings
        cmd = [str(settings.trident_python), str(self._script)]
        logger.info("running perception: %s", " ".join(cmd))
        try:
            proc = subprocess.run(
                cmd,
                input=json.dumps(request),
                capture_output=True,
                text=True,
                timeout=settings.subprocess_timeout_s,
                env=_subprocess_env(),
            )
        except subprocess.TimeoutExpired as exc:
            raise PerceptionError(
                f"perception timed out after {settings.subprocess_timeout_s}s; "
                f"stderr: {_stderr_tail(exc.stderr)}"
            ) from exc
        if proc.returncode != 0:
            raise PerceptionError(
                f"perception failed (rc={proc.returncode}); stderr: {_stderr_tail(proc.stderr)}"
            )
        return proc

    @staticmethod
    def _parse(stdout: str) -> dict:
        """Parse + validate the subprocess stdout into the result dict."""
        try:
            result = json.loads(stdout)
        except ValueError as exc:
            raise PerceptionError(f"perception returned non-JSON stdout: {exc}") from exc
        if not isinstance(result, dict):
            raise PerceptionError("perception returned non-object JSON")
        missing = [k for k in _REQUIRED_KEYS if k not in result]
        if missing:
            raise PerceptionError(f"perception result missing keys: {missing}")
        return result
