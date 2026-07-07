from enum import Enum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base model: accepts + emits camelCase (the JS wire format), also accepts snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class JobStatus(str, Enum):  # noqa: UP042 - pydantic v2 needs a str-mixin Enum, not StrEnum
    queued = "queued"
    running = "running"
    ready = "ready"
    error = "error"


class FeatureSpec(CamelModel):
    """Patch-feature extraction spec (encoder + magnification + patch size)."""

    patch_encoder: str
    mag: int = 20
    patch_size: int = 256


class PreprocessRequest(CamelModel):
    """Client request to preprocess a slide (backbone + optional consensus features)."""

    backbone: FeatureSpec
    consensus: FeatureSpec | None = None
    slidechat: bool = True


class PreprocessResponse(CamelModel):
    """Response to an enqueued preprocess request (job id + cache key + status)."""

    job_id: str
    cache_key: str
    status: JobStatus


class ReadyFlags(CamelModel):
    """Per-artifact readiness flags for a preprocessed case."""

    features: bool = False
    slidechat: bool = False
    classifiers: bool = False


class StatusResponse(CamelModel):
    """Job status snapshot: stage, progress, readiness, and any error."""

    status: JobStatus
    stage: str | None = None
    progress: float = 0.0
    ready: ReadyFlags = Field(default_factory=ReadyFlags)
    error: str | None = None
