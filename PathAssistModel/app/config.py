from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PATHASSIST_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "PathAssistModel"
    env: Literal["dev", "staging", "prod"] = "dev"
    log_level: str = "INFO"
    api_host: str = "0.0.0.0"
    api_port: int = 8081

    girder_api_url: str = "https://gd.pathassist.health/api/v1"
    girder_api_key: Optional[str] = None
    girder_token: Optional[str] = None
    girder_username: Optional[str] = None
    girder_password: Optional[str] = None

    aws_region: str = "us-east-1"
    s3_bucket: Optional[str] = None
    s3_prefix: str = "pathassist-ai"

    celery_broker_url: str = "redis://redis:6379/0"
    celery_result_backend: str = "redis://redis:6379/1"
    task_track_started: bool = True
    task_time_limit_seconds: int = 60 * 60 * 6
    task_soft_time_limit_seconds: int = 60 * 60 * 5

    model_name: str = "hovernet_fast-pannuke"
    output_root: Path = Path("/tmp/pathassist-model")
    keep_workdir: bool = False
    gpu_device: str = "cuda"
    batch_size: int = 8
    num_loader_workers: int = 4
    num_postproc_workers: int = 2
    annotation_chunk_size: int = 2000
    annotation_opacity: float = 0.2
    annotation_line_width: float = 1.0
    annotation_group: str = "ai-hovernet"
    nuclei_type_map_json: Optional[str] = None

    default_tile_size: int = 256
    patch_input_shape: int = 256
    patch_output_shape: int = 164

    spot_instance_type: str = "g5.xlarge"
    spot_ami_id: Optional[str] = None
    spot_subnet_id: Optional[str] = None
    spot_security_group_id: Optional[str] = None
    spot_key_name: Optional[str] = None
    spot_iam_instance_profile: Optional[str] = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.output_root.mkdir(parents=True, exist_ok=True)
    return settings
