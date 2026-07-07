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


@lru_cache
def get_settings() -> Settings:
    return Settings()
