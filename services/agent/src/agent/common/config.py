from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, overridable via AGENT_* env vars.

    Kept intentionally tiny at increment 0 — the control-plane store (Postgres),
    tool registry, and LLM config join in later increments behind stable seams.
    """

    model_config = SettingsConfigDict(env_prefix="AGENT_", env_file=".env", extra="ignore")

    # The copilot authorizes every request against the same Girder the viewer uses. This
    # compile-time default is only a neutral local fallback — deployment sets AGENT_GIRDER_BASE
    # (compose injects http://host.docker.internal:9080/api/v1).
    girder_base: str = "http://localhost:9080/api/v1"
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

    # pathvlm Perceptor service (Inc 2a). Empty ⇒ describe_region reports it isn't configured.
    pathvlm_service_url: str = ""

    # preprocess service (Inc 2b): Trident feature extraction + region retrieval. Empty ⇒
    # find_regions and the preprocess routes report the service isn't configured.
    preprocess_service_url: str = ""

    # biomarker service (Inc 3a): GigaTIME-Flash virtual biomarkers × CellViT nuclei → per-cell
    # phenotypes. Empty ⇒ phenotype_cells reports the service isn't configured.
    biomarker_service_url: str = ""

    # tissue service (Inc 4): dense tissue-class segmentation (Route B). Empty ⇒ the Tissue panel
    # and its routes report the service isn't configured.
    tissue_service_url: str = ""

    # The Girder plugin that dispatches analysis runs onto Celery (Inc 6 · D5). It has to be
    # Girder's own base URL because `create_task_job` only works inside the Girder process; this
    # is a separate setting from `girder_base` so a deployment can point the dispatch at a
    # different Girder host than the one it authorises against without the two silently coupling.
    # Empty ⇒ the gateway falls back to calling the analysis service directly, which is the
    # pre-Inc-6 path and is what keeps a deployment without the plugin working.
    pathassist_plugin_url: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
