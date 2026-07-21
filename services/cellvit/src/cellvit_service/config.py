from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """CellViT service config, overridable via CELLVIT_* env vars."""

    model_config = SettingsConfigDict(env_prefix="CELLVIT_", env_file=".env", extra="ignore")

    # The Girder whose large_image region endpoint we read WSI pixels from.
    girder_base: str = "https://lymphoma.dev.pathassist.health/api/v1"
    device: str = "cuda"  # the real model needs a GPU; the stub ignores this


@lru_cache
def get_settings() -> Settings:
    return Settings()
