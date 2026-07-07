import logging
import os
import subprocess
from pathlib import Path

from ..common.config import Settings
from ..common.schemas import FeatureSpec

logger = logging.getLogger(__name__)


def build_command(slide_path: Path, job_dir: Path, spec: FeatureSpec,
                  settings: Settings) -> list[str]:
    return [
        str(settings.trident_python),
        str(settings.trident_repo / "run_single_slide.py"),
        "--slide_path", str(slide_path),
        "--job_dir", str(job_dir),
        "--patch_encoder", spec.patch_encoder,
        "--mag", str(spec.mag),
        "--patch_size", str(spec.patch_size),
        "--overlap", str(settings.default_overlap),
        "--seg_conf_thresh", str(settings.seg_conf_thresh),
        "--gpu", str(settings.trident_gpu),
    ]


def _subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    tok = env.get("HF_TOKEN") or env.get("HUGGING_FACE_HUB_TOKEN")
    if tok:
        env["HF_TOKEN"] = tok
        env["HUGGING_FACE_HUB_TOKEN"] = tok
    return env


def run_trident(slide_path: Path, job_dir: Path, spec: FeatureSpec, settings: Settings) -> None:
    """Run Trident's single-slide pipeline as a subprocess; raise on failure.

    Logs stdout/stderr to job_dir/trident.log.
    """
    job_dir.mkdir(parents=True, exist_ok=True)
    cmd = build_command(slide_path, job_dir, spec, settings)
    logger.info("running trident: %s", " ".join(cmd))
    proc = subprocess.run(
        cmd, cwd=str(settings.trident_repo), env=_subprocess_env(),
        capture_output=True, text=True, timeout=settings.subprocess_timeout_s,
    )
    (job_dir / "trident.log").write_text(
        (proc.stdout or "") + "\n--- STDERR ---\n" + (proc.stderr or "")
    )
    if proc.returncode != 0:
        raise RuntimeError(f"trident failed (rc={proc.returncode}); see {job_dir / 'trident.log'}")
