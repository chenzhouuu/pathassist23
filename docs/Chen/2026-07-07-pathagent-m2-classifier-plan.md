# PathAgent M2 — Classifier-Consensus Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the slide-level **classifier-consensus pass** (design φ_c) on top of M1: extract a
**consensus** patch-feature set (UNI, `uni_v1`, 1024-dim) via Trident, call the deployed **BRCA
ABMIL** service to get a slide-level diagnosis + top-attention coordinates, cache the result, flip
`ready.classifiers`, and expose it over the gateway — verified end-to-end on real WSIs.

**Architecture:** The existing `run_trident_preprocess` job gains two best-effort stages after the
backbone (conch_v1) features are cached: (1) a **consensus** Trident pass (`uni_v1`) into the same
job dir, and (2) a **classifier** call to the pluggable classifier client. The classifier
(`ClassifierClient`) POSTs the consensus feature h5 path to `POST {brca_service_url}/predict` and
stores a typed `ClassifierResult` as `classifier.json`. Classifier/consensus failure is non-fatal:
backbone features stay `ready`; only `classifiers` stays `false`.

**Tech stack:** unchanged from M1 (FastAPI/RQ, httpx, h5py, Trident subprocess). No new deps.

**Verified facts (this box, 2026-07-07):**
- This host **is** `192.168.191.109` — Girder (`:9080`), BRCA ABMIL (`:11501`), Gemma (`:11500`)
  all run locally; feature paths are on a shared filesystem.
- `GET http://192.168.191.109:11501/health` → `{"status":"ok","model":"ABMIL-BRCA-5fold-ensemble",
  "device":"cuda","folds_loaded":5,"slides_in_db":942}`.
- `POST /predict` body `{"feature_path": "<abs path to a UNI features h5>"}` →
  `{"prediction":"IDC","confidence":90.1,"idc_prob":90.1,"ilc_prob":9.9,"top_patches":[...50 int],
  "top_coords":[[x,y]...50],"top_scores":[...50 float],"patch_size_px":256,"extract_mpp":0.5,
  "num_patches":4260,"model":"ABMIL-BRCA-5fold-ensemble","auc":0.9624}`.
  The ABMIL for `/predict` is **UNI (1024-dim)** — it reads `f["features"]` (N,1024) + `f["coords"]`.
  A `conch_v1` (512-dim) h5 causes an HTTP 500. On bad input the service returns HTTP 200 with an
  `{"error": "..."}` body (e.g. `"Feature file not found: ..."`, `"not_indexed"`).
- Trident supports `--patch_encoder uni_v1` (UNI weights cached in `~/.cache/huggingface`;
  `features_uni_v1/` already exists in `trident_processed`). `top_coords` are level-0 pixels
  (same convention as our manifest geometry).

---

## File structure
- Modify `src/pathagent/common/config.py` — classifier service settings.
- Modify `src/pathagent/common/schemas.py` — `ClassifierResult`.
- Modify `src/pathagent/common/cache_keys.py` — `CachePaths.classifier` path.
- Create `src/pathagent/worker/classifier_client.py` — `ClassifierClient.predict()`.
- Modify `src/pathagent/worker/artifacts.py` — `copy_features()` helper (consensus copy).
- Modify `src/pathagent/worker/trident_preprocess.py` — consensus + classifier stages.
- Modify `src/pathagent/gateway/routes.py` — `GET /cases/{item_id}/classifier`.
- Modify `src/pathagent/scripts/m1_real_slide.py` OR add `scripts/m2_real_slide.py` — real-WSI verify.
- Tests under `tests/`.

---

## Task 1: Classifier settings
**Files:** Modify `common/config.py`; Test `tests/common/test_config.py`.
Add to `Settings`:
```python
    brca_service_url: str = "http://192.168.191.109:11501"
    classifier_enabled: bool = True
    classifier_timeout_s: float = 120.0
    default_consensus_encoder: str = "uni_v1"
```
- [ ] Test: defaults (`brca_service_url` endswith ":11501", `classifier_enabled is True`, `default_consensus_encoder == "uni_v1"`).
- [ ] Test: env override `PATHAGENT_CLASSIFIER_ENABLED=false` → `classifier_enabled is False`.
- [ ] Commit `feat(pathagent): add M2 classifier settings`.

## Task 2: ClassifierResult schema
**Files:** Modify `common/schemas.py`; Test `tests/common/test_schemas.py`.
```python
class ClassifierResult(CamelModel):
    """Slide-level classifier output (BRCA ABMIL: IDC vs ILC + attention)."""
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
```
- [ ] Test: build from the real response dict via `model_validate` (snake or camel keys both accepted), assert `prediction=="IDC"`, `idc_prob==90.1`, `len(top_coords)==2` for a 2-item sample; `model_dump(by_alias=True)` emits `idcProb`, `topCoords`, `numPatches`.
- [ ] Commit `feat(pathagent): add ClassifierResult schema`.

## Task 3: CachePaths.classifier
**Files:** Modify `common/cache_keys.py`; Test `tests/common/test_cache_keys.py`.
Add field `classifier: Path` to `CachePaths` and set `classifier=root / "classifier.json"` in `cache_paths()`.
- [ ] Test: `cache_paths("k").classifier.name == "classifier.json"` and parent == root.
- [ ] Commit `feat(pathagent): add classifier.json cache path`.

## Task 4: Classifier client
**Files:** Create `worker/classifier_client.py`; Test `tests/worker/test_classifier_client.py`.
```python
import logging
import httpx
from ..common.config import Settings
from ..common.schemas import ClassifierResult

logger = logging.getLogger(__name__)

class ClassifierError(RuntimeError):
    """Raised when the classifier service errors or returns an error body."""

class ClassifierClient:
    """Pluggable slide-level classifier backend (BRCA ABMIL /predict)."""

    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.brca_service_url
        self.timeout = settings.classifier_timeout_s

    def predict(self, feature_path: str) -> ClassifierResult:
        """POST a UNI feature h5 path to /predict and parse the result."""
        try:
            resp = httpx.post(
                f"{self.base_url}/predict",
                json={"feature_path": feature_path},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            body = resp.json()
        except httpx.HTTPError as exc:
            raise ClassifierError(f"classifier request failed: {exc}") from exc
        if isinstance(body, dict) and body.get("error"):
            raise ClassifierError(f"classifier error: {body['error']}")
        return ClassifierResult.model_validate(body)
```
- [ ] Test (respx): mock `POST http://svc/predict` returning the real sample JSON; assert a `ClassifierResult` with `prediction=="IDC"` and the request body carried `feature_path`.
- [ ] Test (respx): service returns `{"error":"Feature file not found: x"}` → `ClassifierError`.
- [ ] Test (respx): HTTP 500 → `ClassifierError`.
- [ ] Commit `feat(pathagent): add pluggable classifier client (BRCA ABMIL)`.

## Task 5: consensus-features copy helper
**Files:** Modify `worker/artifacts.py`; Test `tests/worker/test_artifacts.py`.
Add:
```python
def copy_features(job_dir: Path, slide_stem: str, spec: FeatureSpec, overlap: int,
                  paths: CachePaths) -> Path:
    """Copy a secondary (consensus) encoder's Trident features h5 into the flat cache; return dest."""
    sub = _trident_subdir(job_dir, spec, overlap)
    src = sub / f"features_{spec.patch_encoder}" / f"{slide_stem}.h5"
    if not src.is_file():
        raise FileNotFoundError(f"trident features missing: {src}")
    paths.root.mkdir(parents=True, exist_ok=True)
    dest = paths.features(spec.patch_encoder)
    shutil.copy2(src, dest)
    return dest
```
- [ ] Test: synthetic `features_uni_v1/NAME.h5` under a job dir → `copy_features` copies to `paths.features("uni_v1")`; missing → FileNotFoundError.
- [ ] Commit `feat(pathagent): add consensus feature copy helper`.

## Task 6: consensus + classifier stages in the worker
**Files:** Modify `worker/trident_preprocess.py`; Test `tests/worker/test_trident_preprocess.py`.
After the backbone `normalize_and_manifest`, before the final `ready`, insert (best-effort):
```python
    classifiers_ok = False
    consensus = request.consensus
    if settings.classifier_enabled and consensus is not None:
        try:
            registry.set_status(cache_key, StatusResponse(
                status=JobStatus.running, stage="consensus", progress=0.6))
            run_trident(Path(slide_path), job_dir, consensus, settings)
            feat_path = copy_features(job_dir, Path(slide_path).stem, consensus,
                                      settings.default_overlap, paths)
            registry.set_status(cache_key, StatusResponse(
                status=JobStatus.running, stage="classifier", progress=0.85))
            result = ClassifierClient(settings).predict(str(feat_path))
            paths.classifier.write_text(result.model_dump_json(by_alias=True, indent=2))
            classifiers_ok = True
        except Exception:  # noqa: BLE001 - classifier is best-effort; features stay ready
            logger.exception("classifier pass failed (non-fatal): %s", cache_key)
    ...
    ready=ReadyFlags(features=True, slidechat=False, classifiers=classifiers_ok)
```
(Imports: `copy_features`, `ClassifierClient`.)
- [ ] Test (happy, monkeypatched): patch `resolve_slide`, `run_trident` (noop), `normalize_and_manifest`, `copy_features` (returns a path), and `ClassifierClient.predict` (returns a `ClassifierResult`); request has `consensus=FeatureSpec(patch_encoder="uni_v1")`; assert final `ready.classifiers is True` and `paths.classifier` was written.
- [ ] Test (classifier failure non-fatal): patch `ClassifierClient.predict` to raise `ClassifierError`; assert final status is `ready`, `ready.features is True`, `ready.classifiers is False` (job does NOT error).
- [ ] Test (no consensus): request `consensus=None`; assert classifier skipped, `ready.classifiers is False`, status `ready`.
- [ ] Commit `feat(pathagent): run consensus + classifier passes in worker`.

## Task 7: gateway classifier endpoint
**Files:** Modify `gateway/routes.py`; Test `tests/gateway/test_routes.py`.
Add `GET {API_PREFIX}/cases/{item_id}/classifier?cacheKey=...` (auth via `require_user`):
returns the parsed `ClassifierResult` JSON from `cache_paths(cache_key).classifier` (200), or 404
if the file doesn't exist. Validate `item_id`/`cacheKey` as elsewhere (ValueError → 400).
- [ ] Test: write a `classifier.json` under a tmp cache; GET returns 200 with `prediction` field (with a valid Girder-Token via the existing auth stub/override).
- [ ] Test: missing file → 404.
- [ ] Commit `feat(pathagent): add GET classifier result endpoint`.

## Task 8: real-WSI verification
**Files:** Create `scripts/m2_real_slide.py` (or extend `m1_real_slide.py`).
Run the full pipeline on a real slide with `backbone=conch_v1` + `consensus=uni_v1` (inline,
fakeredis registry, real Trident, real BRCA service). Assert: status `ready`; `ready.classifiers`
True; `features_conch_v1.h5` and `features_uni_v1.h5` (N×1024) exist; `classifier.json` parses to a
`ClassifierResult` with `prediction in {"IDC","ILC"}`, `0<=confidence<=100`, `len(top_coords)>0`, and
every top coord within `level0_width/height` from the manifest.
- [ ] Run on a real TCGA-BRCA slide (in the classifier's training domain) AND a BRACS slide; capture output.
- [ ] Write `docs/Chen/2026-07-07-pathagent-m2-report.md`.
- [ ] Commit.

---

## Self-review notes
- **Pluggable classifier:** `ClassifierClient` is the only classifier-specific code; the BRCA
  service is one backend behind a typed interface — swap-friendly, honoring the design's
  pluggability and avoiding hard-coupling to one MIL model.
- **Best-effort classifier:** backbone features remain the guaranteed artifact; classifier failure
  never fails preprocessing.
- **Coordinate contract:** `top_coords` are level-0 pixels, consistent with the manifest geometry —
  ready for the M4 OSD attention overlay.
- **Cache keys:** `compute_cache_key` already varies by `consensus`, so M2 (consensus set) cases get
  distinct keys from M1; no `PIPELINE_VERSION` bump needed.
- **SlideChat (LLM slide reasoner) stays deferred** — not available on this box; M2 delivers the
  classifier-consensus pass only.
