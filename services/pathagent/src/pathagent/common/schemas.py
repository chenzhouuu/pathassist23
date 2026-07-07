from enum import Enum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base model: accepts + emits camelCase (the JS wire format), also accepts snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    ready = "ready"
    error = "error"


class FeatureSpec(CamelModel):
    patch_encoder: str
    mag: int = 20
    patch_size: int = 256


class PreprocessRequest(CamelModel):
    backbone: FeatureSpec
    consensus: FeatureSpec | None = None
    slidechat: bool = True


class PreprocessResponse(CamelModel):
    job_id: str
    cache_key: str
    status: JobStatus


class ReadyFlags(CamelModel):
    features: bool = False
    slidechat: bool = False
    classifiers: bool = False


class StatusResponse(CamelModel):
    status: JobStatus
    stage: str | None = None
    progress: float = 0.0
    ready: ReadyFlags = Field(default_factory=ReadyFlags)
    error: str | None = None
