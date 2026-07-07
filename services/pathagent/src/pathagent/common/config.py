from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, overridable via PATHAGENT_* env vars."""

    model_config = SettingsConfigDict(env_prefix="PATHAGENT_", env_file=".env", extra="ignore")

    girder_base: str = "https://lymphoma.dev.pathassist.health/api/v1"
    redis_url: str = "redis://localhost:6379/0"
    cache_dir: Path = Path("/data/pathagent-cache")
    default_patch_encoder: str = "conch_v1"
    default_mag: int = 20
    default_patch_size: int = 256

    trident_python: Path = Path("/home/chen/miniconda3/envs/pathology/bin/python")
    trident_repo: Path = Path("/home/chen/MIL-Lab/trident")
    trident_gpu: int = 0
    seg_conf_thresh: float = 0.5
    default_overlap: int = 0
    slides_root: Path | None = None
    subprocess_timeout_s: int = 3600

    brca_service_url: str = "http://192.168.191.109:11501"
    classifier_enabled: bool = True
    classifier_timeout_s: float = 120.0
    default_consensus_encoder: str = "uni_v1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
