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


class ClassifierResult(CamelModel):
    """Slide-level classifier output (BRCA ABMIL: IDC vs ILC + attention)."""

    # The service also emits `top_patches` (attention indices); intentionally ignored here.
    model: str
    prediction: str
    confidence: float
    idc_prob: float
    ilc_prob: float
    num_patches: int
    auc: float | None = None
    patch_size_px: int | None = None
    extract_mpp: float | None = None
    top_coords: list[list[int]] = Field(default_factory=list)
    top_scores: list[float] = Field(default_factory=list)


class ROI(CamelModel):
    """A rectangular region of interest in level-0 slide coordinates."""

    x: int
    y: int
    width: int
    height: int


class AgentQueryRequest(CamelModel):
    """Client request to the M3 orchestrator for a case question."""

    item_id: str
    cache_key: str
    question: str
    task: str = "auto"  # "auto" | "Diagnosis"
    roi: ROI | None = None


class Candidate(CamelModel):
    """A candidate answer from a single source (classifier or LLM)."""

    source: str  # "classifier" | "llm"
    answer: str
    detail: str = ""


class Citation(CamelModel):
    """A supporting citation snippet with its source."""

    text: str
    source: str


class VerifyScores(CamelModel):
    """Verification scores: per-signal φ components and the combined φ_total."""

    phi_l: float
    phi_k: float
    phi_c: float
    phi_total: float


class Manifest(CamelModel):
    """Typed description of a preprocessed case's cached artifacts."""

    cache_key: str
    item_id: str
    slide_name: str
    backbone: FeatureSpec
    patch_count: int
    feature_dim: int
    level0_width: int
    level0_height: int
    level0_magnification: float
    target_magnification: float
    patch_size_level0: int
    overlap: int
    pipeline_version: str
    artifacts: dict[str, str] = Field(default_factory=dict)
