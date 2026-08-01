import logging

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..common.config import get_settings
from ..loop import AgentLoop, StubAgentLoop
from ..loop.artifact_admin import artifact_usage, delete_artifact
from ..loop.artifacts import ArtifactStore, InMemoryArtifactStore
from ..loop.biomarker_map_client import (
    enqueue_map,
    get_map_json,
    get_tile,
    map_job_status,
)
from ..loop.events import RunFinished
from ..loop.nuclei_client import (
    cancel_nuclei,
    enqueue_nuclei,
    get_nuclei_meta,
    get_nuclei_tile,
    nuclei_job_status,
)
from ..loop.pathassist_dispatch import DispatchUnavailable, dispatch_run
from ..loop.preprocess_client import (
    get_contours,
    get_job_status,
    get_prediction,
    list_tasks,
    trigger_preprocess,
    trigger_stage,
)
from ..loop.tissue_map_client import (
    cancel_tissue,
    enqueue_tissue,
    get_tissue_json,
    get_tissue_tile,
    tissue_job_status,
)
from ..loop.tools import ToolContext
from ..store import (
    ConversationStore,
    MemoryPreprocessArtifactStore,
    PreprocessArtifactStore,
    SlideIndexStore,
)
from .auth import require_user
from .sse import sse_json

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/copilot")


def get_store(request: Request) -> ConversationStore:
    """Resolve the process-wide ConversationStore set up by the app lifespan."""
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Copilot store unavailable")
    return store


def get_agent(request: Request) -> AgentLoop:
    """Resolve the process-wide agent loop; fall back to the stub loop if unset (tests)."""
    return getattr(request.app.state, "agent", None) or StubAgentLoop()


def get_artifacts(request: Request) -> ArtifactStore:
    """Resolve the process-wide artifact store (D4); fall back to in-memory if unset."""
    store = getattr(request.app.state, "artifacts", None)
    if store is None:
        store = InMemoryArtifactStore()
        request.app.state.artifacts = store
    return store


def get_girder_token(
    girder_token: str | None = Header(default=None, alias="Girder-Token"),
) -> str | None:
    """The caller's raw Girder token, threaded server-side to data tools (never the model)."""
    return girder_token


def get_cellvit_url() -> str | None:
    """The configured CellViT service URL (None ⇒ run_segmentation keeps the canned stub)."""
    return get_settings().cellvit_service_url or None


def get_pathvlm_url() -> str | None:
    """The configured pathvlm Perceptor URL (None ⇒ describe_region is unavailable)."""
    return get_settings().pathvlm_service_url or None


def get_preprocess_url() -> str | None:
    """The configured preprocess service URL (None ⇒ find_regions / preprocess are unavailable)."""
    return get_settings().preprocess_service_url or None


def get_biomarker_url() -> str | None:
    """The configured biomarker service URL (None ⇒ phenotype_cells is unavailable)."""
    return get_settings().biomarker_service_url or None


def get_tissue_url() -> str | None:
    """The configured tissue service URL (None ⇒ the Tissue panel is unavailable)."""
    return get_settings().tissue_service_url or None


def get_plugin_url() -> str | None:
    """The Girder plugin that dispatches runs onto Celery (Inc 6 · D5).

    None ⇒ the pre-Inc-6 path: the gateway calls the analysis service directly and reconciles the
    row by polling. Keeping that fallback is what lets a deployment without the plugin installed
    keep working while the image is rebuilt.
    """
    return get_settings().pathassist_plugin_url or None


def get_slide_index_store(request: Request) -> SlideIndexStore:
    """Resolve the process-wide SlideIndexStore set up by the app lifespan."""
    store = getattr(request.app.state, "slide_index", None)
    if store is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Slide index unavailable")
    return store


def get_preprocess_artifact_store(request: Request) -> PreprocessArtifactStore:
    """Resolve the process-wide PreprocessArtifactStore (Inc 2b-3 DAG control plane).

    Falls back to an in-memory store if unset (DB-free tests) so the DAG routes stay testable.
    """
    store = getattr(request.app.state, "preprocess_artifacts", None)
    if store is None:
        store = MemoryPreprocessArtifactStore()
        request.app.state.preprocess_artifacts = store
    return store


def _uid(user: dict) -> str:
    """The stable Girder user id used to scope ownership."""
    return str(user.get("_id") or user.get("login"))


def _snippet(text: str, limit: int = 48) -> str:
    """First line of a message, trimmed — used to auto-title a fresh conversation."""
    first = text.strip().split("\n", 1)[0].strip()
    return first[:limit] + ("…" if len(first) > limit else "")


def _num(v: float) -> str:
    """Render whole numbers without a trailing .0 (ROI pixel coords are integral)."""
    return str(int(v)) if float(v).is_integer() else str(v)


def _with_roi(text: str, roi: dict | None) -> str:
    """Append a grounding note so the model can cite the ROI's coordinates (D8)."""
    if not roi:
        return text
    return (
        f"{text}\n\n[Region of interest on the slide — {roi.get('kind', 'rect')} at "
        f"x={_num(roi['x'])}, y={_num(roi['y'])}, "
        f"width={_num(roi['width'])}px, height={_num(roi['height'])}px (image pixels).]"
    )


def _scope(conv: dict, roi: dict | None) -> dict:
    """The spatial scope a turn is grounded to: the active slide and any bound ROI."""
    return {"item_id": conv.get("item_id"), "roi": roi}


@router.get("/health")
async def health() -> dict[str, str]:
    """Unauthenticated liveness probe. `chat` tells the UI which backend is live: the real
    Claude agent loop when keyed, else the deterministic keyless stub."""
    chat = "claude" if get_settings().anthropic_api_key else "echo"
    return {"status": "ok", "service": "copilot", "version": "0.7.0", "chat": chat}


# ── Conversations (persistence) ──────────────────────────────────────────────────


class NewConversation(BaseModel):
    item_id: str | None = None
    title: str | None = None


@router.post("/conversations")
async def create_conversation(
    body: NewConversation,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> dict:
    return await store.create_conversation(user=_uid(user), item=body.item_id, title=body.title)


@router.get("/conversations")
async def list_conversations(
    item_id: str | None = Query(default=None),
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> dict:
    convs = await store.list_conversations(user=_uid(user), item=item_id)
    return {"conversations": convs}


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: int,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> dict:
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    # The turns ARE the memory (transcript); no separate plan/claim/blackboard read-model.
    conv["turns"] = await store.get_turns(conversation_id=conversation_id)
    return conv


class Roi(BaseModel):
    kind: str = "rect"
    x: float
    y: float
    width: float
    height: float
    unit: str = "px"


# ── Autonomous agent turn (the SDK-loop seam) ────────────────────────────────────


class Viewport(BaseModel):
    """The current OpenSeadragon viewport in level-0 pixels (D8) — injected so the loop
    can ground a client-side viewer tool on where the user is actually looking."""

    x: float
    y: float
    width: float
    height: float
    unit: str = "px"


class TurnRequest(BaseModel):
    text: str = Field(..., min_length=1)
    roi: Roi | None = None
    viewer: Viewport | None = None


@router.post("/conversations/{conversation_id}/turns")
async def post_turn(
    conversation_id: int,
    body: TurnRequest,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
    agent: AgentLoop = Depends(get_agent),
    artifacts: ArtifactStore = Depends(get_artifacts),
    token: str | None = Depends(get_girder_token),
    cellvit_url: str | None = Depends(get_cellvit_url),
    pathvlm_url: str | None = Depends(get_pathvlm_url),
    preprocess_url: str | None = Depends(get_preprocess_url),
    biomarker_url: str | None = Depends(get_biomarker_url),
    preprocess_artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
) -> EventSourceResponse:
    """Run one Claude-Code-style autonomous turn, streaming the typed event trace.

    The agent loop reasons, calls tools, and answers in a single turn — there is no
    separate plan/approve/run. It emits typed events (run · reasoning · tool_call · text)
    the frontend renders as a live trace with tool cards. The user turn is persisted
    *before* streaming and the assistant's final answer when the run finishes, so a reload
    survives an interrupted stream. The persisted turns are the conversation's memory.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    if not conv.get("title"):
        await store.set_title_if_empty(conversation_id=conversation_id, title=_snippet(body.text))
    roi = body.roi.model_dump() if body.roi else None
    await store.add_turn(conversation_id=conversation_id, role="user", content=body.text, roi=roi)

    # Full history (incl. the turn just saved) is the loop's context; any ROI bound to a
    # turn is folded into that message so the model can cite its coordinates (D8).
    turns = await store.get_turns(conversation_id=conversation_id)
    history = [{"role": t["role"], "content": _with_roi(t["text"], t.get("roi"))} for t in turns]
    scope = _scope(conv, roi)
    viewer = body.viewer.model_dump() if body.viewer else None
    # Server-tool execution context: bulk output is written to the artifact store and only
    # a handle rides the stream (D4). The Girder token + CellViT/pathvlm URLs ride here
    # server-side only (D3) — the model never sees any of them.
    ctx = ToolContext(
        owner=_uid(user), conversation_id=conversation_id, artifacts=artifacts,
        girder_token=token, cellvit_url=cellvit_url, pathvlm_url=pathvlm_url,
        preprocess_url=preprocess_url, biomarker_url=biomarker_url,
        preprocess_artifacts=preprocess_artifacts,
    )

    async def turn_stream():
        final = ""
        try:
            async for ev in agent.run(
                text=body.text, history=history, scope=scope, viewer=viewer, ctx=ctx,
            ):
                if isinstance(ev, RunFinished):
                    final = ev.text
                yield sse_json(ev.as_event())
        except Exception as exc:  # noqa: BLE001 — surface any loop failure to the client
            logger.exception("agent turn failed for conversation %s", conversation_id)
            if final:
                await store.add_turn(
                    conversation_id=conversation_id, role="assistant", content=final
                )
            yield sse_json({
                "type": "run_error",
                "message": f"The agent loop failed ({type(exc).__name__}).",
            })
            return
        if final:
            await store.add_turn(conversation_id=conversation_id, role="assistant", content=final)

    return EventSourceResponse(turn_stream())


@router.get("/conversations/{conversation_id}/artifacts/{ref}")
async def get_turn_artifact(
    conversation_id: int,
    ref: str,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
    artifacts: ArtifactStore = Depends(get_artifacts),
    token: str | None = Depends(get_girder_token),
) -> dict:
    """Fetch a turn artifact's bulk geometry out-of-band by its handle `ref` (D4).

    Owner-scoped: the conversation must be the caller's. The caller's Girder token is
    threaded to the store so the durable (DSA-annotation) backend can authorize the read
    against Girder; the in-memory backend ignores it and scopes by owner.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    geometry = await artifacts.get(owner=_uid(user), ref=ref, token=token)
    if geometry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    return geometry


# ── Slide preprocessing (Trident index control plane — Inc 2b) ───────────────────


class PreprocessRequest(BaseModel):
    """Optional overrides; the worker fills defaults (image encoder / 20× / 256 / HEST)."""

    encoder: str | None = None
    mag: int | None = None
    patch_size: int | None = None
    segmenter: str | None = None


async def _reconcile(store: SlideIndexStore, item: str, params_hash: str, js: dict) -> None:
    """Fold a worker /status reply into the durable slide_index row (only the gateway writes)."""
    st = js.get("status")
    if st == "ready":
        await store.set_status(
            item=item, params_hash=params_hash, status="ready", stage="done", progress=1.0,
            n_patches=js.get("n_patches"), feature_ref=js.get("features_ref"),
        )
    elif st == "failed":
        await store.set_status(
            item=item, params_hash=params_hash, status="failed",
            error=js.get("error") or "preprocess failed",
        )
    elif st in ("queued", "running"):
        await store.set_status(
            item=item, params_hash=params_hash, status=st,
            stage=js.get("stage"), progress=js.get("progress"),
        )


@router.post("/slides/{item}/preprocess")
async def start_preprocess(
    item: str,
    body: PreprocessRequest,
    user: dict = Depends(require_user),
    slide_index: SlideIndexStore = Depends(get_slide_index_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """Enqueue a Trident index build and record its durable slide_index row (F7).

    Fast: proxies a non-blocking POST /run to the worker (which owns the single-consumer GPU
    queue) and creates/reset the row to `queued`. The heavy build never runs in this request.
    """
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    params = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        run = await trigger_preprocess(
            base_url=preprocess_url, item=item, params=params, token=token
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc
    return await slide_index.upsert_index(
        item=item, params_hash=run["params_hash"], encoder=run["encoder"], mag=run["mag"],
        patch_size=run["patch_size"], segmenter=run["segmenter"],
        status="queued", job_id=run.get("job_id"),
    )


@router.get("/slides/{item}/index")
async def list_slide_index(
    item: str,
    user: dict = Depends(require_user),
    slide_index: SlideIndexStore = Depends(get_slide_index_store),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """List a slide's preprocess indexes, reconciling in-flight builds against the worker."""
    rows = await slide_index.list_indexes(item=item)
    if preprocess_url:
        for row in rows:
            if row["status"] in ("queued", "running") and row.get("job_id"):
                try:
                    js = await get_job_status(base_url=preprocess_url, job_id=row["job_id"])
                except httpx.HTTPError:
                    continue  # worker unreachable — keep the last known state
                await _reconcile(slide_index, item, row["params_hash"], js)
        rows = await slide_index.list_indexes(item=item)
    return {"indexes": rows}


# ── Preprocess DAG (segment → patch → features control plane — Inc 2b-3) ──────────


class SegmentRequest(BaseModel):
    """Tissue-segmentation params; the worker fills defaults (HEST / conf 0.5)."""

    segmenter: str | None = None
    seg_conf_thresh: float | None = None
    remove_artifacts: bool = False
    remove_holes: bool = False
    remove_penmarks: bool = False


class ArtifactResultRequest(BaseModel):
    """How a dispatched run ended, as the Celery driver saw it (Inc 6 · ticket 01).

    Only outcomes that leave bytes on disk are accepted; a failure has no artifact to describe and
    is recorded entirely on the Girder job.
    """

    status: str
    result: dict | None = None


class PatchRequest(BaseModel):
    """Tiling params; runs on a ready segmentation (``seg_hash``)."""

    seg_hash: str
    mag: int | None = None
    patch_size: int | None = None
    overlap: int | None = None


class FeaturesRequest(BaseModel):
    """Feature-extraction params; runs on a ready patch grid (``patch_hash``)."""

    patch_hash: str
    encoder: str | None = None


class PredictRequest(BaseModel):
    """Downstream-task inference; runs on a ready feature index (``feat_hash``)."""

    feat_hash: str
    task_id: str


# The prediction summary the panel reads straight off the artifact row. Per-patch arrays stay on
# disk and are fetched separately by the heatmap route.
_RESULT_KEYS = (
    "task_id", "model_ver", "classes", "probs", "pred_index", "pred_label", "n_patches",
    "elapsed_ms",
)

# The tissue map's composition, carried on the artifact row for both a finished and a stopped
# build. `stopped`/`remaining` ride along so the panel can offer Resume and say how much is left.
# What a finished nuclei build has to say. `stopped`/`remaining` ride along for ticket 07's
# Resume, the same way the tissue map's do.
_NUCLEI_RESULT_KEYS = (
    "art_hash", "n_nuclei", "counts_by_class", "n_tiles", "area_mm2", "stopped", "remaining",
)

_TISSUE_RESULT_KEYS = (
    "art_hash", "n_tiles", "n_core_tiles", "fraction", "fraction_soft", "tsr", "covered_mm2",
    "stopped", "remaining",
)

# Which of a worker's result keys survive onto the row, and which one the Workspace counts, per
# kind. A stopped build has to be folded in with the same table as a finished one — reading a
# stopped nuclei run through the tissue map's keys would drop its class histogram and leave the
# row with no count at all.
_RESULT_KEYS_BY_KIND = {"nuclei": _NUCLEI_RESULT_KEYS, "tissue": _TISSUE_RESULT_KEYS}
_N_ITEMS_KEY_BY_KIND = {"nuclei": "n_nuclei", "tissue": "n_core_tiles", "biomarker": "n_cells"}


async def _reconcile_artifact(
    store: PreprocessArtifactStore, item: str, art_hash: str, js: dict, kind: str | None = None,
) -> None:
    """Fold a worker /status reply into the durable artifact row (only the gateway writes)."""
    st = js.get("status")
    if st == "cancelled":
        # A stopped build is not a failed one: it left a smaller but complete artifact on disk,
        # with coverage and tallies to match, so its numbers are carried exactly as a finished
        # build's are. Progress stays where the worker left it — that fraction is the honest one.
        res = js.get("result") or {}
        keys = _RESULT_KEYS_BY_KIND.get(kind or "", _TISSUE_RESULT_KEYS)
        await store.set_status(
            item=item, art_hash=art_hash, status="cancelled", stage="stopped",
            progress=js.get("progress"),
            n_items=res.get(_N_ITEMS_KEY_BY_KIND.get(kind or "", "n_core_tiles")),
            result={k: res[k] for k in keys if k in res} or None,
        )
    elif st == "ready":
        n_patches = js.get("n_patches")
        n_items = n_patches if n_patches is not None else js.get("n_contours")
        result = None
        if kind == "prediction":
            result = {k: js[k] for k in _RESULT_KEYS if k in js}
        elif kind == "biomarker":
            # The biomarker worker reports through a JobQueue, so its payload sits under
            # "result" rather than at the top level like the preprocess stages.
            res = js.get("result") or {}
            result = {k: res[k] for k in ("art_hash", "n_tiles", "n_new_tiles", "n_cells",
                                          "seconds") if k in res}
            n_items = res.get("n_cells", n_items)
        elif kind == "nuclei":
            # The nuclei worker reports through a JobQueue like the map workers, so its payload
            # sits under "result". The counts ride on the row so the Workspace can render them
            # straight from /artifacts, without a second call per row.
            res = js.get("result") or {}
            result = {k: res[k] for k in _NUCLEI_RESULT_KEYS if k in res}
            n_items = res.get("n_nuclei", n_items)
        elif kind == "tissue":
            # Same JobQueue shape as the biomarker worker: the payload sits under "result".
            # The composition is carried on the row so the panel can render numbers straight from
            # /artifacts without a second round trip to the tissue worker.
            res = js.get("result") or {}
            result = {k: res[k] for k in _TISSUE_RESULT_KEYS if k in res}
            n_items = res.get("n_core_tiles", n_items)
        await store.set_status(
            item=item, art_hash=art_hash, status="ready", stage="done", progress=1.0,
            n_items=n_items, dim=js.get("dim"),
            artifact_ref=(
                js.get("features_ref") or js.get("coords_ref") or js.get("contours_ref")
                or js.get("prediction_ref")
            ),
            result=result or None,
        )
    elif st == "failed":
        await store.set_status(
            item=item, art_hash=art_hash, status="failed",
            error=js.get("error") or "preprocess failed",
        )
    elif st in ("queued", "running"):
        await store.set_status(
            item=item, art_hash=art_hash, status=st,
            stage=js.get("stage"), progress=js.get("progress"),
        )


_WORKER_REFUSALS = {
    status.HTTP_404_NOT_FOUND: "the preprocess service does not know that task",
    status.HTTP_409_CONFLICT: "upstream stage not built yet",
    status.HTTP_503_SERVICE_UNAVAILABLE: "the preprocess worker cannot run downstream tasks",
}


async def _trigger_dag_stage(
    *, preprocess_url: str | None, stage: str, item: str, params: dict, token: str | None,
) -> dict:
    """Proxy a non-blocking POST /{stage} to the worker, mapping HTTP failures to gateway errors."""
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    try:
        return await trigger_stage(
            base_url=preprocess_url, stage=stage, item=item, params=params, token=token
        )
    except httpx.HTTPStatusError as exc:
        # The worker's own refusals are meaningful to the panel and are forwarded verbatim:
        # 409 upstream stage not built · 404 unknown task · 503 this image ships without torch.
        # Anything else is a genuine gateway-side failure.
        code = exc.response.status_code
        if code in _WORKER_REFUSALS:
            try:
                detail = exc.response.json().get("detail", _WORKER_REFUSALS[code])
            except ValueError:
                detail = _WORKER_REFUSALS[code]
            raise HTTPException(code, detail) from exc
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"the preprocess service rejected the request: {exc}"
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc


_SEG_PARAM_KEYS = (
    "segmenter", "seg_conf_thresh", "remove_artifacts", "remove_holes", "remove_penmarks",
)


async def _content_address(preprocess_url: str | None, kind: str, item: str, params: dict) -> dict:
    """Ask the preprocess service what a run with these params would be called.

    The gateway needs the address before it dispatches, because a dispatched run goes onto a Celery
    queue and never comes back through here. It does not compute the hash itself: a second copy of
    `artifacts.seg_hash` would be free to drift from the one the service uses, which is how
    `conch_v1` ended up meaning two different embeddings.
    """
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    try:
        async with httpx.AsyncClient(base_url=preprocess_url, timeout=15.0) as client:
            resp = await client.post("/hash", json={"kind": kind, **params})
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc


@router.post("/slides/{item}/segment")
async def start_segment(
    item: str,
    body: SegmentRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
    plugin_url: str | None = Depends(get_plugin_url),
) -> dict:
    """Enqueue a tissue segmentation and record its durable artifact row.

    Two paths, and which one runs is a deployment fact rather than a request one. With the Girder
    plugin configured the run becomes a Girder job on this box's Celery queue (Inc 6 · D4/D5) and
    the row's `job_id` is that job's; without it, the pre-Inc-6 path calls the service directly.
    Either way the gateway owns the same three things — the content address, the reuse check and
    the row.
    """
    params = {k: v for k, v in body.model_dump().items() if v is not None}

    if not plugin_url:
        run = await _trigger_dag_stage(
            preprocess_url=preprocess_url, stage="segment", item=item, params=params, token=token
        )
        return await artifacts.upsert_artifact(
            item=item, kind="segmentation", art_hash=run["seg_hash"], parent_hash=None,
            params={k: run[k] for k in _SEG_PARAM_KEYS if k in run},
            status="queued", job_id=run.get("job_id"),
        )

    addressed = await _content_address(preprocess_url, "segmentation", item, params)
    art_hash = addressed["art_hash"]
    resolved = addressed.get("params") or params

    # Dispatch, then write — one write, and no row without a job behind it. Creating the Girder
    # job is a single fast call that enqueues rather than runs, so the row still appears before
    # anyone could look for it; ordering it this way is what makes "a queued row that nothing will
    # ever pick up" unrepresentable instead of something to clean up afterwards.
    try:
        ack = await dispatch_run(
            plugin_url=plugin_url, kind="segmentation", item=item, art_hash=art_hash,
            params=params, token=token,
        )
    except DispatchUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return await artifacts.upsert_artifact(
        item=item, kind="segmentation", art_hash=art_hash, parent_hash=None,
        params={k: resolved[k] for k in _SEG_PARAM_KEYS if k in resolved},
        status="queued", job_id=ack["jobId"],
    )


@router.post("/slides/{item}/artifacts/{art_hash}/result")
async def report_artifact_result(
    item: str,
    art_hash: str,
    body: ArtifactResultRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
) -> dict:
    """The driver reporting how a run ended (Inc 6 · ticket 01).

    Called for `ready` and for `cancelled` — both leave usable bytes on disk, and a stopped run's
    tallies describe the smaller artifact it did produce. A failed run reports nothing: its whole
    story is the Girder job, and there is no artifact to describe.

    Authorised as the user who submitted the run, because the driver carries that user's token.
    """
    if body.status not in ("ready", "cancelled"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{body.status!r} is not an outcome that leaves an artifact",
        )
    # Asked before writing, because `set_status` mutates in place in both store implementations
    # and cannot itself report a row that was never there. A driver reporting against an artifact
    # this slide does not have is a real case — the row can be deleted from the Workspace while
    # its job is still running.
    if await artifacts.get_artifact(item=item, art_hash=art_hash) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such artifact for this slide")

    result = body.result or {}
    await artifacts.set_status(
        item=item, art_hash=art_hash, status=body.status,
        stage="done" if body.status == "ready" else "stopped",
        progress=1.0 if body.status == "ready" else None,
        n_items=next(
            (result[k] for k in ("n_nuclei", "n_core_tiles", "n_cells", "n_patches", "n_contours")
             if isinstance(result.get(k), int)),
            None,
        ),
        artifact_ref=(
            result.get("features_ref") or result.get("coords_ref") or result.get("contours_ref")
            or result.get("prediction_ref")
        ),
        result=result or None,
    )
    return await artifacts.get_artifact(item=item, art_hash=art_hash)


@router.post("/slides/{item}/patch")
async def start_patch(
    item: str,
    body: PatchRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """Enqueue a patch grid on a ready segmentation (409 if that segmentation isn't built)."""
    params = {k: v for k, v in body.model_dump().items() if v is not None}
    run = await _trigger_dag_stage(
        preprocess_url=preprocess_url, stage="patch", item=item, params=params, token=token
    )
    return await artifacts.upsert_artifact(
        item=item, kind="patching", art_hash=run["patch_hash"], parent_hash=run["seg_hash"],
        params={k: run[k] for k in ("mag", "patch_size", "overlap") if k in run},
        status="queued", job_id=run.get("job_id"),
    )


@router.post("/slides/{item}/features")
async def start_features(
    item: str,
    body: FeaturesRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """Enqueue feature extraction on a ready patch grid (409 if that patch grid isn't built)."""
    params = {k: v for k, v in body.model_dump().items() if v is not None}
    run = await _trigger_dag_stage(
        preprocess_url=preprocess_url, stage="features", item=item, params=params, token=token
    )
    return await artifacts.upsert_artifact(
        item=item, kind="features", art_hash=run["feat_hash"], parent_hash=run["patch_hash"],
        params={"encoder": run.get("encoder")}, status="queued", job_id=run.get("job_id"),
    )


@router.get("/slides/{item}/artifacts")
async def list_slide_artifacts(
    item: str,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    preprocess_url: str | None = Depends(get_preprocess_url),
    biomarker_url: str | None = Depends(get_biomarker_url),
    tissue_url: str | None = Depends(get_tissue_url),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> dict:
    """List a slide's DAG artifacts, reconciling in-flight builds against the worker."""
    rows = await artifacts.list_artifacts(item=item)
    dirty = False
    for row in rows:
        if row["status"] not in ("queued", "running") or not row.get("job_id"):
            continue
        # Map builds run in DIFFERENT workers, so each kind is polled at its own base URL;
        # everything else about the row is identical.
        kind = row["kind"]
        base = _service_for(
            kind, preprocess_url=preprocess_url, biomarker_url=biomarker_url,
            tissue_url=tissue_url, cellvit_url=cellvit_url,
        )
        if not base:
            continue
        poll = {
            "biomarker": map_job_status, "tissue": tissue_job_status, "nuclei": nuclei_job_status,
        }.get(kind, get_job_status)
        try:
            js = await poll(base_url=base, job_id=row["job_id"])
        except httpx.HTTPError:
            continue  # worker unreachable — keep the last known state
        await _reconcile_artifact(artifacts, item, row["art_hash"], js, row["kind"])
        dirty = True
    if dirty:
        rows = await artifacts.list_artifacts(item=item)
    return {"artifacts": rows}


def _service_for(
    kind: str, *, preprocess_url, biomarker_url, tissue_url, cellvit_url=None,
) -> str | None:
    """Which worker owns this kind — its bytes, and its job status. One table, both uses."""
    return {
        "biomarker": biomarker_url, "tissue": tissue_url, "nuclei": cellvit_url,
    }.get(kind, preprocess_url)


def _dependants(rows: list[dict], art_hash: str) -> list[dict]:
    """Rows built on top of this one, named the way the panel names them (never by hash alone)."""
    return [
        {"kind": r["kind"], "art_hash": r["art_hash"], "params": r.get("params") or {}}
        for r in rows if r.get("parent_hash") == art_hash
    ]


@router.get("/slides/{item}/artifacts/{art_hash}/usage")
async def artifact_usage_and_dependants(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    preprocess_url: str | None = Depends(get_preprocess_url),
    biomarker_url: str | None = Depends(get_biomarker_url),
    tissue_url: str | None = Depends(get_tissue_url),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> dict:
    """The two things a delete dialog has to say before it offers the button: how much this frees,
    and what is holding it. Answered together because asking them separately invites a UI that
    shows a size for something it is then refused permission to delete."""
    rows = await artifacts.list_artifacts(item=item)
    row = next((r for r in rows if r["art_hash"] == art_hash), None)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such artifact on this slide")
    base = _service_for(
        row["kind"], preprocess_url=preprocess_url, biomarker_url=biomarker_url,
        tissue_url=tissue_url, cellvit_url=cellvit_url,
    )
    used = await artifact_usage(
        base_url=base, kind=row["kind"], item=item, art_hash=art_hash,
    ) if base else 0
    return {"bytes": used, "dependants": _dependants(rows, art_hash)}


@router.delete("/slides/{item}/artifacts/{art_hash}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_slide_artifact(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    preprocess_url: str | None = Depends(get_preprocess_url),
    biomarker_url: str | None = Depends(get_biomarker_url),
    tissue_url: str | None = Depends(get_tissue_url),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> Response:
    """Remove an artifact: the row first, then its bytes.

    **Never cascades** (D8). The DAG is deep and one click must not be able to erase hours of GPU
    time, so an artifact something was built on is refused, with the dependants named.

    **Row before directory.** A crash between the two leaves an orphan directory, which is
    recoverable — content addressing means a re-run rebuilds and overwrites it. The other order
    leaves a row pointing at nothing, which is not: the re-run finds the row, believes the work is
    done, and hands back an artifact whose bytes are gone.
    """
    rows = await artifacts.list_artifacts(item=item)
    row = next((r for r in rows if r["art_hash"] == art_hash), None)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such artifact on this slide")

    held_by = _dependants(rows, art_hash)
    if held_by:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"detail": "other artifacts were built from this one", "dependants": held_by},
        )

    await artifacts.delete_artifact(item=item, art_hash=art_hash)
    base = _service_for(
        row["kind"], preprocess_url=preprocess_url, biomarker_url=biomarker_url,
        tissue_url=tissue_url, cellvit_url=cellvit_url,
    )
    if base:
        try:
            await delete_artifact(base_url=base, kind=row["kind"], item=item, art_hash=art_hash)
        except httpx.HTTPError:
            # The row is already gone, so the artifact is gone as far as the app is concerned. Say
            # so rather than failing a delete the user cannot retry — what is left is an orphan
            # directory, which the next build of the same hash overwrites.
            logger.warning("artifact %s row deleted but its directory was not removed", art_hash)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/tasks")
async def list_downstream_tasks(
    user: dict = Depends(require_user),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """The downstream-task registry (Inc 2c), plus whether this worker can actually run one."""
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    try:
        return await list_tasks(base_url=preprocess_url)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc


@router.post("/slides/{item}/predict")
async def start_predict(
    item: str,
    body: PredictRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """Enqueue a task prediction on a ready feature index.

    409 if that feature index isn't built; 503 if the worker ships without torch — both are the
    worker's own refusals, forwarded so the panel can say which it is.
    """
    params = body.model_dump()
    run = await _trigger_dag_stage(
        preprocess_url=preprocess_url, stage="predict", item=item, params=params, token=token
    )
    return await artifacts.upsert_artifact(
        item=item, kind="prediction", art_hash=run["pred_hash"], parent_hash=run["feat_hash"],
        params={"task_id": run.get("task_id"), "model_ver": run.get("model_ver")},
        status="queued", job_id=run.get("job_id"),
    )


@router.get("/slides/{item}/prediction/{pred_hash}/heatmap")
async def get_prediction_heatmap(
    item: str,
    pred_hash: str,
    user: dict = Depends(require_user),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """A prediction's per-patch arrays — level-0 coords, attention and signed class evidence.

    Kept off the artifact row on purpose: this is thousands of floats, fetched only when a heatmap
    is actually drawn.
    """
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    try:
        doc = await get_prediction(base_url=preprocess_url, item=item, pred_hash=pred_hash)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no prediction for that pred_hash")
    return doc


@router.get("/slides/{item}/segmentation/{seg_hash}/contours")
async def get_segmentation_contours(
    item: str,
    seg_hash: str,
    user: dict = Depends(require_user),
    preprocess_url: str | None = Depends(get_preprocess_url),
) -> dict:
    """Proxy a segmentation's tissue contours (level-0 GeoJSON) for the viewer overlay (Phase 5)."""
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    try:
        gj = await get_contours(base_url=preprocess_url, item=item, seg_hash=seg_hash)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc
    if gj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no segmentation contours for that seg_hash")
    return gj


# ── Biomarker map (Inc 3b): virtual-mIF + phenotype tile pyramids, agent-independent ─────
#
# The compute lives in the biomarker service (D2); this is the control plane + an authenticated
# tile proxy. Artifact rows ride the SAME table as the preprocess DAG with kind="biomarker" and
# parent_hash=seg_hash, so /tasks polling, progress and restartability come free.


class BiomarkerRequest(BaseModel):
    """Enqueue a map build. ``bbox`` omitted/null ⇒ the whole slide (D5)."""

    seg_hash: str
    bbox: dict | None = None
    # The cells the phenotypes are attached to. Required by the worker (Inc 5, D9), and the row's
    # real parent — see start_biomarker.
    nuclei_hash: str | None = None


def _need_biomarker(url: str | None) -> str:
    if not url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The biomarker service is not configured (AGENT_BIOMARKER_SERVICE_URL)",
        )
    return url


_MAP_REFUSALS = {
    status.HTTP_400_BAD_REQUEST: "the biomarker worker rejected those parameters",
    status.HTTP_404_NOT_FOUND: "the biomarker worker does not know that artifact",
    status.HTTP_503_SERVICE_UNAVAILABLE: "the biomarker worker has no GigaTIME-Flash weights",
}


def _map_error(exc: httpx.HTTPError) -> HTTPException:
    """Forward the worker's own refusals; anything else is a genuine gateway-side failure."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in _MAP_REFUSALS:
            try:
                detail = exc.response.json().get("detail", _MAP_REFUSALS[code])
            except ValueError:
                detail = _MAP_REFUSALS[code]
            return HTTPException(code, detail)
    return HTTPException(
        status.HTTP_502_BAD_GATEWAY, f"could not reach the biomarker service: {exc}"
    )


@router.get("/biomarker/catalog")
async def biomarker_catalog(
    user: dict = Depends(require_user),
    biomarker_url: str | None = Depends(get_biomarker_url),
) -> dict:
    """Presets, marker vocabulary, phenotype palette — so the panel hardcodes no biology."""
    try:
        doc = await get_map_json(base_url=_need_biomarker(biomarker_url), path="/biomarker/catalog")
    except httpx.HTTPError as exc:
        raise _map_error(exc) from exc
    if doc is None:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "biomarker catalog unavailable")
    return doc


@router.post("/slides/{item}/biomarker")
async def start_biomarker(
    item: str,
    body: BiomarkerRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    biomarker_url: str | None = Depends(get_biomarker_url),
) -> dict:
    """Enqueue (or extend) this slide's marker/phenotype map and record its artifact row.

    The parent is the **nuclei** artifact, not the segmentation (Inc 5, D9). A phenotype is an
    attribute of a nucleus: change the cells and every number changes, whereas the tissue mask only
    ever decided which tiles were worth visiting. Recording it this way is what makes ticket 04
    refuse to delete nuclei that a phenotype map is standing on, and it is why the Workspace can
    show the chain at all. The segmentation stays in `params`, where it is provenance.
    """
    try:
        run = await enqueue_map(
            base_url=_need_biomarker(biomarker_url), item=item,
            seg_hash=body.seg_hash, bbox=body.bbox, nuclei_hash=body.nuclei_hash, token=token,
        )
    except httpx.HTTPError as exc:
        raise _map_error(exc) from exc
    return await artifacts.upsert_artifact(
        item=item, kind="biomarker", art_hash=run["art_hash"],
        parent_hash=body.nuclei_hash or body.seg_hash,
        params={"scope": run.get("scope"), "bbox": body.bbox, "seg_hash": body.seg_hash,
                "nuclei_hash": body.nuclei_hash},
        status="queued", job_id=run.get("job_id"),
    )


@router.get("/slides/{item}/biomarker/{art_hash}/meta")
async def biomarker_meta(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    biomarker_url: str | None = Depends(get_biomarker_url),
) -> dict:
    """The artifact's layer geometry, thresholds, coverage and whole-map counts."""
    try:
        doc = await get_map_json(
            base_url=_need_biomarker(biomarker_url),
            path=f"/biomarker/{item}/{art_hash}/meta",
        )
    except httpx.HTTPError as exc:
        raise _map_error(exc) from exc
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no biomarker map for that hash")
    return doc


@router.get("/slides/{item}/biomarker/{art_hash}/cells/{tx}/{ty}")
async def biomarker_cells(
    item: str,
    art_hash: str,
    tx: int,
    ty: int,
    user: dict = Depends(require_user),
    biomarker_url: str | None = Depends(get_biomarker_url),
) -> dict:
    """One core tile's per-cell records — hover, region stats and export read this."""
    try:
        doc = await get_map_json(
            base_url=_need_biomarker(biomarker_url),
            path=f"/biomarker/{item}/{art_hash}/cells/{tx}/{ty}",
        )
    except httpx.HTTPError as exc:
        raise _map_error(exc) from exc
    return doc or {"cells": []}


@router.get("/slides/{item}/biomarker/{art_hash}/tile/{layer}/{z}/{x}/{y}.png")
async def biomarker_tile(
    item: str,
    art_hash: str,
    layer: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    user: dict = Depends(require_user),
    biomarker_url: str | None = Depends(get_biomarker_url),
) -> Response:
    """Authenticated proxy for one composited tile.

    The channel selection, colours and display transfer function all live in the query string
    (D3), so they are forwarded verbatim — the gateway never interprets them. Cache headers are
    passed through too, because an unchanged (art_hash, threshold_rev, query) tile is immutable
    and re-fetching it on every pan is the one thing that would make this feel slow.
    """
    try:
        tile = await get_tile(
            base_url=_need_biomarker(biomarker_url),
            path=f"/biomarker/{item}/{art_hash}/tile/{layer}/{z}/{x}/{y}.png",
            params=dict(request.query_params),
        )
    except httpx.HTTPError as exc:
        raise _map_error(exc) from exc
    headers = {}
    if tile.cache_control:
        headers["Cache-Control"] = tile.cache_control
    if tile.etag:
        headers["ETag"] = tile.etag
    return Response(
        content=tile.body, media_type=tile.content_type,
        status_code=tile.status_code, headers=headers,
    )


# ── Tissue map (Inc 4): dense tissue-class segmentation, agent-independent ───────────────
#
# The compute lives in the tissue service on :8023 (D2); this is the control plane plus an
# authenticated tile proxy. Artifact rows ride the SAME table as the preprocess DAG with
# kind="tissue" and parent_hash=seg_hash, so /artifacts polling, progress and restartability come
# free — exactly as for kind="biomarker".


class TissueRequest(BaseModel):
    """Enqueue a tissue-map build. ``bbox`` omitted/null ⇒ the whole slide."""

    seg_hash: str
    bbox: dict | None = None
    backend: str | None = None


def _need_tissue(url: str | None) -> str:
    if not url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The tissue service is not configured (AGENT_TISSUE_SERVICE_URL)",
        )
    return url


_TISSUE_REFUSALS = {
    status.HTTP_400_BAD_REQUEST: "the tissue worker rejected those parameters",
    status.HTTP_404_NOT_FOUND: "the tissue worker does not know that artifact",
    status.HTTP_503_SERVICE_UNAVAILABLE: "the tissue worker has no segmentation weights",
}


def _tissue_error(exc: httpx.HTTPError) -> HTTPException:
    """Forward the worker's own refusals; anything else is a genuine gateway-side failure."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in _TISSUE_REFUSALS:
            try:
                detail = exc.response.json().get("detail", _TISSUE_REFUSALS[code])
            except ValueError:
                detail = _TISSUE_REFUSALS[code]
            return HTTPException(code, detail)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"could not reach the tissue service: {exc}")


# ── Nuclei (Inc 5) ───────────────────────────────────────────────────────────────


class NucleiRequest(BaseModel):
    bbox: dict | None = None
    # Only a whole-slide run needs it, and only to pick the tiles worth the GPU. It is not the
    # artifact's parent: see start_nuclei.
    seg_hash: str | None = None


_NUCLEI_REFUSALS = {
    status.HTTP_400_BAD_REQUEST: "the nuclei worker rejected those parameters",
    status.HTTP_404_NOT_FOUND: "the nuclei worker does not know that artifact",
    status.HTTP_503_SERVICE_UNAVAILABLE: "the nuclei worker has no segmentation weights",
    status.HTTP_507_INSUFFICIENT_STORAGE: "the nuclei cache has no room for a whole-slide run",
}


def _nuclei_error(exc: httpx.HTTPError) -> HTTPException:
    """Forward the worker's own refusals; anything else is a genuine gateway-side failure."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in _NUCLEI_REFUSALS:
            try:
                detail = exc.response.json().get("detail", _NUCLEI_REFUSALS[code])
            except ValueError:
                detail = _NUCLEI_REFUSALS[code]
            return HTTPException(code, detail)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"could not reach the cellvit service: {exc}")


def _need_cellvit(url: str | None) -> str:
    if not url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The cellvit service is not configured"
        )
    return url


@router.post("/slides/{item}/nuclei")
async def start_nuclei(
    item: str,
    body: NucleiRequest,
    user: dict = Depends(require_user),
    token: str | None = Depends(get_girder_token),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> dict:
    """Enqueue (or extend) this slide's nuclei build and record its durable row.

    No `parent_hash`, even for a whole-slide run that names a `seg_hash`. Unlike the tissue and
    biomarker maps, a nucleus outline does not depend on a segmentation: the mask decides which
    tiles are worth the GPU, which is coverage, and deleting it later invalidates nothing here. It
    is recorded in `params` as provenance, not as a DAG edge — a delete of the segmentation is
    therefore not refused on this artifact's account, which is correct.
    """
    try:
        run = await enqueue_nuclei(
            base_url=_need_cellvit(cellvit_url), item=item, bbox=body.bbox,
            seg_hash=body.seg_hash, token=token,
        )
    except httpx.HTTPError as exc:
        raise _nuclei_error(exc) from exc
    return await artifacts.upsert_artifact(
        item=item, kind="nuclei", art_hash=run["art_hash"], parent_hash=None,
        params={"scope": run.get("scope"), "bbox": body.bbox, "backend": run.get("backend"),
                "seg_hash": body.seg_hash},
        status="queued", job_id=run.get("job_id"),
    )


@router.post("/slides/{item}/nuclei/{art_hash}/cancel")
async def cancel_nuclei_build(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> dict:
    """Stop this slide's running nuclei build at its next core-tile boundary.

    A whole-slide run is hours of work holding the cellvit service's only worker, so it has to be
    interruptible. What is already computed stays: the artifact keeps its coverage and tallies, and
    starting the same build again resumes from there rather than from the beginning.

    The durable row is **not** written here — the worker owns the transition, and marking the row
    stopped while the worker is still finishing a core would be undone by the next reconciliation.
    """
    row = await artifacts.get_artifact(item=item, art_hash=art_hash)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no nuclei build for that hash")
    if not row.get("job_id"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "that nuclei build has no running job to stop"
        )
    try:
        return await cancel_nuclei(base_url=_need_cellvit(cellvit_url), job_id=row["job_id"])
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != status.HTTP_404_NOT_FOUND:
            raise _nuclei_error(exc) from exc
        # The worker has never heard of this job — it was restarted out from under the row, which
        # leaves the panel polling a build that will never move again. Stop is the right moment to
        # settle that: the job is gone, so say so. Whatever it computed is still on disk and
        # starting the build again resumes from there.
        await artifacts.set_status(
            item=item, art_hash=art_hash, status="cancelled", stage="stopped", error=None,
        )
        return {"job_id": row["job_id"], "status": "cancelled", "stage": "stopped",
                "detail": "the cellvit worker restarted; this build is no longer running"}
    except httpx.HTTPError as exc:
        raise _nuclei_error(exc) from exc


@router.get("/slides/{item}/nuclei/{art_hash}/meta")
async def nuclei_meta(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> dict:
    try:
        return await get_nuclei_meta(
            base_url=_need_cellvit(cellvit_url), item=item, art_hash=art_hash,
        )
    except httpx.HTTPError as exc:
        raise _nuclei_error(exc) from exc


@router.get("/slides/{item}/nuclei/{art_hash}/tile/{layer}/{z}/{x}/{y}.png")
async def nuclei_tile(
    item: str,
    art_hash: str,
    layer: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    user: dict = Depends(require_user),
    cellvit_url: str | None = Depends(get_cellvit_url),
) -> Response:
    """Authenticated proxy for one rendered tile of the nuclei mask.

    Class selection, colours and opacity live in the query string and are forwarded verbatim — the
    gateway never interprets them. Cache headers pass through, because an unchanged
    (art_hash, coverage, query) tile is immutable.
    """
    try:
        tile = await get_nuclei_tile(
            base_url=_need_cellvit(cellvit_url),
            path=f"/nuclei/{item}/{art_hash}/tile/{layer}/{z}/{x}/{y}.png",
            params=dict(request.query_params),
        )
    except httpx.HTTPError as exc:
        raise _nuclei_error(exc) from exc
    headers = {}
    if tile.cache_control:
        headers["Cache-Control"] = tile.cache_control
    if tile.etag:
        headers["ETag"] = tile.etag
    return Response(
        content=tile.body, media_type=tile.content_type,
        status_code=tile.status_code, headers=headers,
    )


@router.get("/tissue/catalog")
async def tissue_catalog(
    user: dict = Depends(require_user),
    tissue_url: str | None = Depends(get_tissue_url),
) -> dict:
    """Backends, their class lists and palettes — so the panel hardcodes no biology."""
    try:
        doc = await get_tissue_json(base_url=_need_tissue(tissue_url), path="/tissue/catalog")
    except httpx.HTTPError as exc:
        raise _tissue_error(exc) from exc
    if doc is None:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "tissue catalog unavailable")
    return doc


@router.post("/slides/{item}/tissue")
async def start_tissue(
    item: str,
    body: TissueRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    tissue_url: str | None = Depends(get_tissue_url),
) -> dict:
    """Enqueue (or extend) this slide's tissue map and record its artifact row."""
    try:
        run = await enqueue_tissue(
            base_url=_need_tissue(tissue_url), item=item, seg_hash=body.seg_hash,
            bbox=body.bbox, backend=body.backend, token=token,
        )
    except httpx.HTTPError as exc:
        raise _tissue_error(exc) from exc
    return await artifacts.upsert_artifact(
        item=item, kind="tissue", art_hash=run["art_hash"], parent_hash=body.seg_hash,
        params={"scope": run.get("scope"), "bbox": body.bbox, "backend": run.get("backend")},
        status="queued", job_id=run.get("job_id"),
    )


@router.post("/slides/{item}/tissue/{art_hash}/cancel")
async def cancel_tissue_build(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    tissue_url: str | None = Depends(get_tissue_url),
) -> dict:
    """Stop this slide's running tissue build at its next core-tile boundary.

    A whole-slide map is hours of work holding the tissue service's only worker, so it has to be
    interruptible. What is already computed stays: the artifact keeps its coverage and tallies, and
    starting the same build again resumes from there rather than from the beginning.

    The durable row is **not** written here — the worker owns the transition, and marking the row
    stopped while the worker is still finishing a core would be undone by the next reconciliation.
    """
    row = await artifacts.get_artifact(item=item, art_hash=art_hash)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no tissue build for that hash")
    if not row.get("job_id"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "that tissue build has no running job to stop"
        )
    try:
        return await cancel_tissue(base_url=_need_tissue(tissue_url), job_id=row["job_id"])
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != status.HTTP_404_NOT_FOUND:
            raise _tissue_error(exc) from exc
        # The worker has never heard of this job — it was restarted out from under the row, which
        # leaves the panel polling a build that will never move again. Stop is the right moment to
        # settle that: the job is gone, so say so. Whatever it computed is still on disk and
        # starting the build again resumes from there.
        await artifacts.set_status(
            item=item, art_hash=art_hash, status="cancelled", stage="stopped",
            error=None,
        )
        return {"job_id": row["job_id"], "status": "cancelled", "stage": "stopped",
                "detail": "the tissue worker restarted; this build is no longer running"}
    except httpx.HTTPError as exc:
        raise _tissue_error(exc) from exc


@router.get("/slides/{item}/tissue/{art_hash}/meta")
async def tissue_meta(
    item: str,
    art_hash: str,
    user: dict = Depends(require_user),
    tissue_url: str | None = Depends(get_tissue_url),
) -> dict:
    """The artifact's backend, class list, layer geometry, coverage and composition."""
    try:
        doc = await get_tissue_json(
            base_url=_need_tissue(tissue_url), path=f"/tissue/{item}/{art_hash}/meta",
        )
    except httpx.HTTPError as exc:
        raise _tissue_error(exc) from exc
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no tissue map for that hash")
    return doc


@router.get("/slides/{item}/tissue/{art_hash}/stats")
async def tissue_stats(
    item: str,
    art_hash: str,
    request: Request,
    user: dict = Depends(require_user),
    tissue_url: str | None = Depends(get_tissue_url),
) -> dict:
    """Class composition for a sub-rectangle (``bbox=x,y,w,h``) or the whole artifact."""
    try:
        doc = await get_tissue_json(
            base_url=_need_tissue(tissue_url), path=f"/tissue/{item}/{art_hash}/stats",
            params=dict(request.query_params),
        )
    except httpx.HTTPError as exc:
        raise _tissue_error(exc) from exc
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no tissue map for that hash")
    return doc


@router.get("/slides/{item}/tissue/{art_hash}/tile/{layer}/{z}/{x}/{y}.png")
async def tissue_tile(
    item: str,
    art_hash: str,
    layer: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    user: dict = Depends(require_user),
    tissue_url: str | None = Depends(get_tissue_url),
) -> Response:
    """Authenticated proxy for one rendered tile.

    The class selection, colours, opacity and render mode all live in the query string, so they
    are forwarded verbatim — the gateway never interprets them. Cache headers pass through too,
    because an unchanged (art_hash, coverage, query) tile is immutable.
    """
    try:
        tile = await get_tissue_tile(
            base_url=_need_tissue(tissue_url),
            path=f"/tissue/{item}/{art_hash}/tile/{layer}/{z}/{x}/{y}.png",
            params=dict(request.query_params),
        )
    except httpx.HTTPError as exc:
        raise _tissue_error(exc) from exc
    headers = {}
    if tile.cache_control:
        headers["Cache-Control"] = tile.cache_control
    if tile.etag:
        headers["ETag"] = tile.etag
    return Response(
        content=tile.body, media_type=tile.content_type,
        status_code=tile.status_code, headers=headers,
    )


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: int,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> Response:
    removed = await store.delete_conversation(user=_uid(user), conversation_id=conversation_id)
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
