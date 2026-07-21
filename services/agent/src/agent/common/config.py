from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, overridable via AGENT_* env vars.

    Kept intentionally tiny at increment 0 — the control-plane store (Postgres),
    tool registry, and LLM config join in later increments behind stable seams.
    """

    model_config = SettingsConfigDict(env_prefix="AGENT_", env_file=".env", extra="ignore")

    # The copilot authorizes every request against the same Girder the viewer uses.
    girder_base: str = "https://lymphoma.dev.pathassist.health/api/v1"
    cors_origins: list[str] = ["*"]

    # Control-plane store (increment 1). Default targets the compose `db` service;
    # override with AGENT_DATABASE_URL for local runs (e.g. localhost:5432).
    database_url: str = "postgresql://copilot:copilot@db:5432/copilot"

    # Chat model (increment 2). With no key the copilot degrades to the echo
    # responder, so the framework still runs end-to-end without Anthropic access.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"
    anthropic_max_tokens: int = 1024

    # CellViT inference service (R11). Empty ⇒ run_segmentation keeps the canned stub.
    cellvit_service_url: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
