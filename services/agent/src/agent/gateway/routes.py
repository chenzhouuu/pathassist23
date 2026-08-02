import logging

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..common.config import get_settings
from ..loop import AgentLoop, StubAgentLoop
from ..loop.artifact_admin import artifact_usage, delete_artifact
from ..loop.artifacts import ArtifactStore, InMemoryArtifactStore
from ..loop.biomarker_map_client import get_map_json, get_tile
from ..loop.events import RunFinished
from ..loop.nuclei_client import get_nuclei_meta, get_nuclei_tile
from ..loop.pathassist_dispatch import DispatchUnavailable, dispatch_chain, dispatch_run
from ..loop.preprocess_client import (
    get_contours,
    get_job_status,
    get_prediction,
    list_tasks,
    trigger_preprocess,
)
from ..loop.tissue_map_client import get_tissue_json, get_tissue_tile
from ..loop.tools import ToolContext
from ..store import (
    ConversationStore,
    MemoryPreprocessArtifactStore,
    PreprocessArtifactStore,
    SlideIndexStore,
)
from .auth import require_user
from .plan import address_chain, match_feature_spec, missing_suffix
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
    """How a dispatched run ended, as the Celery driver saw it (Inc 6 · tickets 01 and 05).

    Only outcomes that leave bytes on disk are accepted; a failure has no artifact to describe and
    is recorded entirely on the Girder job.

    `kind` and `params` are what let a report **create** the row. A kind that has moved to the D9
    shape (nuclei, 05) has no row until its bytes exist, so the report is the row's first write;
    for the kinds still writing a row at dispatch they are redundant and ignored.
    """

    status: str
    result: dict | None = None
    kind: str | None = None
    params: dict | None = None
    parent_hash: str | None = None
    girder_job_id: str | None = None


class BuildRequest(BaseModel):
    """One feature-index build: the encoder, and the two upstream stages it implies (Inc 6 · 07).

    `patching` and `features` have no request model of their own any more, because they have no
    route of their own. They are interior stages of this build, and their params are here — the
    tiling geometry beside the encoder that binds it, which is the whole point of Fork B.
    """

    encoder: str | None = None
    # stage 1 — segmentation
    segmenter: str | None = None
    seg_conf_thresh: float | None = None
    remove_artifacts: bool = False
    remove_holes: bool = False
    remove_penmarks: bool = False
    # stage 2 — tiling
    mag: int | None = None
    patch_size: int | None = None
    overlap: int | None = None


class PredictRequest(BaseModel):
    """Downstream-task inference.

    `feat_hash` is optional, and that is what makes "run this task on this slide" a single
    submission (Inc 6 · 07). Given one, the task runs on that index. Given none, the gateway looks
    for an index matching what the task's weights were trained on, and plans the build when there
    is none — so a slide with nothing on it reaches a call in one click, and one that already has
    the right index spends one queue slot instead of four.
    """

    task_id: str
    feat_hash: str | None = None


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


#: Which params of a segmentation the gateway carries forward when it seeds a build from one this
#: slide already has. `impl` is not among them: it is a property of the image that will run the
#: *new* work, and the service fills it in.
_SEG_SEED_KEYS = (
    "segmenter", "seg_conf_thresh", "remove_artifacts", "remove_holes", "remove_penmarks",
)


def _need_preprocess_stack(preprocess_url: str | None, plugin_url: str | None) -> None:
    """Both halves have to be there before a DAG run can be planned, and they fail differently."""
    if not preprocess_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The preprocess service is not configured"
        )
    if not plugin_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The analysis job queue is not configured, so this run cannot be scheduled",
        )


async def _plan_and_dispatch(
    *, preprocess_url: str, plugin_url: str, item: str, token: str | None,
    artifacts: PreprocessArtifactStore, target: str, params_by_kind: dict, label: str,
    known_parent: tuple[str, str] | None = None,
) -> dict:
    """Address the chain, drop what this slide already has, and queue the rest.

    **No row is written here.** A dispatched run writes its row when it reports its bytes
    (`report_artifact_result`), which is the shape nuclei took in 05 and the last four kinds take
    here: a row is a claim that bytes exist, and until they do the run lives entirely on its Girder
    job. That is also why nothing needs cleaning up when a chain stops halfway — the steps that did
    not run left nothing behind.

    A submission with nothing left to run is answered, not queued. Under content addressing the
    second identical build is a no-op, and saying so beats spending a queue slot to rediscover it.
    """
    rows = await artifacts.list_artifacts(item=item)
    have = {r["art_hash"] for r in rows}

    async def address(kind: str, params: dict) -> dict:
        return await _content_address(preprocess_url, kind, item, params)

    steps = await address_chain(address, target, params_by_kind, known_parent=known_parent)
    todo = missing_suffix(steps, have)
    final = steps[-1]

    if not todo:
        return {"kind": target, "art_hash": final.art_hash, "status": "ready", "steps": [],
                "reused": True}

    try:
        ack = await dispatch_chain(
            plugin_url=plugin_url, item=item, token=token, label=label,
            steps=[s.as_json() for s in todo],
        )
    except DispatchUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return {
        "kind": target, "art_hash": final.art_hash, "status": "queued",
        "steps": [{"kind": s.kind, "art_hash": s.art_hash} for s in todo],
        "chain_id": ack.get("chainId"), "girder_job_id": ack.get("jobId"),
    }


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
    """Queue a tissue segmentation.

    A one-step chain, so it goes through exactly the same planning as the three-step build below —
    including the reuse check, which is why asking twice for the same contours costs nothing.

    The pre-Inc-6 path that called the service directly is gone (07). It existed so segmentation
    could keep working while the queue was being built; keeping it now would mean two ways for a
    run to exist, only one of which appears in the Runs list.
    """
    _need_preprocess_stack(preprocess_url, plugin_url)
    return await _plan_and_dispatch(
        preprocess_url=preprocess_url, plugin_url=plugin_url, item=item, token=token,
        artifacts=artifacts, target="segmentation", label="Tissue segmentation",
        params_by_kind={
            "segmentation": {k: v for k, v in body.model_dump().items() if v is not None},
        },
    )


@router.post("/slides/{item}/build")
async def start_build(
    item: str,
    body: BuildRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
    plugin_url: str | None = Depends(get_plugin_url),
) -> dict:
    """Queue a feature index: segment, then tile, then encode (Inc 6 · 07).

    One submission rather than three, because the three are one decision. The encoder is the build
    target and it binds the tiling geometry (Fork B, Inc 2b-3) — tiles cut at a size no encoder
    wants are minutes of GPU nobody can use, which is why `patching` and `features` are not offered
    as catalog entries of their own.

    Whatever this slide already has is skipped, so a second encoder over the same tiles queues one
    step, not three.
    """
    _need_preprocess_stack(preprocess_url, plugin_url)
    form = body.model_dump()
    return await _plan_and_dispatch(
        preprocess_url=preprocess_url, plugin_url=plugin_url, item=item, token=token,
        artifacts=artifacts, target="features", label="Feature index",
        params_by_kind={
            "segmentation": {k: v for k, v in form.items()
                             if k in _SEG_SEED_KEYS and v is not None},
            "patching": {k: form[k] for k in ("mag", "patch_size", "overlap")
                         if form.get(k) is not None},
            "features": {"encoder": form["encoder"]} if form.get("encoder") else {},
        },
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

    **A missing row is created, not refused** (Inc 6 · 05). For a kind on the D9 shape there is no
    row until the bytes exist, so this is the row's first write and the driver has to say what kind
    it is. Two other cases land here and both want the same answer: a row deleted from the
    Workspace while its job was still running, and a run that stored bytes the deletion did not
    reach. In every one of them a row exists afterwards because bytes do, which is the whole rule.

    An existing row is updated in place rather than upserted, so that params the *worker* resolved
    at dispatch (a segmenter left at its default, say) are not overwritten by the raw request the
    driver was handed.
    """
    if body.status not in ("ready", "cancelled"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{body.status!r} is not an outcome that leaves an artifact",
        )
    if await artifacts.get_artifact(item=item, art_hash=art_hash) is None:
        if not body.kind:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "no such artifact for this slide, and the report does not say what kind to create",
            )
        await artifacts.upsert_artifact(
            item=item, kind=body.kind, art_hash=art_hash,
            parent_hash=body.parent_hash or _parent_of(body.kind, body.params),
            params=body.params or {}, status=body.status, girder_job_id=body.girder_job_id,
        )

    result = body.result or {}
    await artifacts.set_status(
        item=item, art_hash=art_hash, status=body.status, girder_job_id=body.girder_job_id,
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


#: Which of a run's params is the artifact's DAG parent, per kind (Inc 6 · 06).
#:
#: Derived here rather than plumbed through the dispatch, because the parent is a fact about the
#: DAG and the driver has no view of one — it dials a URL and forwards a result. The gateway is
#: what refuses to delete an artifact something else stands on, so the gateway is what says which
#: edges exist.
#:
#: `nuclei` is absent on purpose: a whole-slide run names a `seg_hash` to pick the tiles worth the
#: GPU, which is coverage, not dependence — deleting the segmentation invalidates no nucleus.
#: `biomarker` points at the nuclei rather than the segmentation for the mirror-image reason: a
#: phenotype is an attribute of a cell, so different cells mean different numbers (Inc 5 · D9).
#:
#: The preprocess DAG's three edges joined in 07 and are the literal case: a patch grid is cut from
#: contours, a feature index encodes a patch grid, a prediction reads a feature index — each one's
#: hash contains its parent's, so deleting a parent would leave a child nothing could reproduce.
_PARENT_PARAM_BY_KIND = {
    "tissue": "seg_hash",
    "biomarker": "nuclei_hash",
    "patching": "seg_hash",
    "features": "patch_hash",
    "prediction": "feat_hash",
}


def _parent_of(kind: str | None, params: dict | None) -> str | None:
    """The artifact this run's output depends on, off its own params. None when there is no edge."""
    key = _PARENT_PARAM_BY_KIND.get(kind or "")
    return (params or {}).get(key) if key else None


# `POST /slides/{item}/patch` and `/features` are gone (07). They were the two interior stages of a
# build, dispatched one at a time by a panel that watched for the previous one to finish — the
# auto-advance loop `preprocessUtils.nextChainStep` drove. Both are now steps of `POST .../build`,
# sequenced by Celery instead of by whoever had the tab open, which is also what makes a build
# survive a closed browser.


@router.get("/slides/{item}/artifacts")
async def list_slide_artifacts(
    item: str,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
) -> dict:
    """List a slide's DAG artifacts. Reads, and nothing else.

    **The reconcile loop is gone (07).** Every kind now writes its row once, from the run that
    produced the bytes, so there is no in-flight row for a reader to advance. What that removes is
    the defect the plan measured: rows only moved while somebody had this list open, and a worker
    restart left them `running` for ever. Run state was never this table's to hold — it is on the
    Girder job, which is durable and answers whether or not anyone is looking.
    """
    return {"artifacts": await artifacts.list_artifacts(item=item)}


def _service_for(
    kind: str, *, preprocess_url, biomarker_url, tissue_url, cellvit_url=None,
) -> str | None:
    """Which worker owns this kind's bytes, for the delete that removes them.

    Only deletion asks now: the status half of this went kind by kind through 05–07, and with it
    the only reason the gateway ever dialled a worker to find out how a run was going.
    """
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


async def _task_spec(preprocess_url: str, task_id: str) -> dict:
    """The build a task's weights were fitted on, off the registry. 404 for a task nobody has."""
    try:
        registry = await list_tasks(base_url=preprocess_url)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not reach the preprocess service: {exc}"
        ) from exc
    task = next((t for t in registry.get("tasks") or [] if t.get("id") == task_id), None)
    if task is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"this deployment has no task called {task_id!r}"
        )
    return task


def _seed_seg_params(rows: list[dict]) -> dict:
    """Segmentation params for a build nobody typed them for.

    A task states the encoder and the tiling its weights want, and says nothing about segmentation
    — correctly, because it does not care (`satisfies_spec` explains why the segmenter is not part
    of the match). But a build has to segment *something*, and cutting a second set of contours
    over a slide that already has one is minutes of GPU spent to arrive back where it started. So
    the slide's own segmentation is reused when it has one, and the service's defaults are used
    when it does not.
    """
    # The most recently touched one — `list_artifacts` orders newest first, and the newest is the
    # one whose contours the user has most recently had a reason to want.
    seg = next((r for r in rows if r.get("kind") == "segmentation"), None)
    params = (seg or {}).get("params") or {}
    return {k: params[k] for k in _SEG_SEED_KEYS if k in params}


@router.post("/slides/{item}/predict")
async def start_predict(
    item: str,
    body: PredictRequest,
    user: dict = Depends(require_user),
    artifacts: PreprocessArtifactStore = Depends(get_preprocess_artifact_store),
    token: str | None = Depends(get_girder_token),
    preprocess_url: str | None = Depends(get_preprocess_url),
    plugin_url: str | None = Depends(get_plugin_url),
) -> dict:
    """Queue a downstream task, building the feature index it needs if the slide has none.

    Which of the two happens is not the caller's decision to make, because it is not a preference —
    it is a fact about the slide. Given a `feat_hash`, that index is used. Otherwise the slide's
    artifacts are searched for one matching the task's declared `feature_spec`, and when there is
    none the whole chain is planned: segment, tile, encode, predict, in one submission.

    What is deliberately *not* done is running on whatever feature index happens to be there. An
    ABMIL head fitted on CONCH v1 at 512 px will happily consume UNI vectors of the same width and
    return a confident number, and nothing downstream would say it was nonsense (Inc 2c).
    """
    _need_preprocess_stack(preprocess_url, plugin_url)
    task = await _task_spec(preprocess_url, body.task_id)
    spec = task.get("feature_spec") or {}

    rows = await artifacts.list_artifacts(item=item)
    match = match_feature_spec(rows, spec) if not body.feat_hash else None
    feat_hash = body.feat_hash or (match["art_hash"] if match else None)

    common = dict(
        preprocess_url=preprocess_url, plugin_url=plugin_url, item=item, token=token,
        artifacts=artifacts, target="prediction", label=task.get("label") or body.task_id,
    )
    if feat_hash:
        # Naming the index is an assertion that it exists, so the three steps above it are neither
        # addressed nor planned. Reconstructing the segmentation params it happened to be built
        # with would be work in service of a question nobody asked.
        return await _plan_and_dispatch(
            **common, known_parent=("features", feat_hash),
            params_by_kind={"prediction": {"task_id": body.task_id}},
        )

    return await _plan_and_dispatch(
        **common,
        params_by_kind={
            "segmentation": _seed_seg_params(rows),
            "patching": {k: spec[k] for k in ("mag", "patch_size", "overlap") if k in spec},
            "features": {"encoder": spec.get("encoder")} if spec.get("encoder") else {},
            "prediction": {"task_id": body.task_id},
        },
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
    token: str | None = Depends(get_girder_token),
    biomarker_url: str | None = Depends(get_biomarker_url),
    plugin_url: str | None = Depends(get_plugin_url),
) -> dict:
    """Dispatch a marker/phenotype map run onto this box's queue (Inc 6 · 06). Writes no row.

    The same shape nuclei took in 05: the address is computed before dispatch, the run becomes a
    Girder job, and no artifact row is written here — under D9 a row is the claim that bytes exist
    on disk, and at this moment none do. The row is written when the driver reports.

    The parent is the **nuclei** artifact, not the segmentation (Inc 5, D9). A phenotype is an
    attribute of a nucleus: change the cells and every number changes, whereas the tissue mask only
    ever decided which tiles were worth visiting. Recording it this way is what makes ticket 04
    refuse to delete nuclei that a phenotype map is standing on, and it is why the Workspace can
    show the chain at all. The segmentation stays in `params`, where it is provenance. The gateway
    derives that edge at report time (`_parent_of`), because the driver knows nothing about the DAG.
    """
    if not plugin_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "marker maps go on the Girder job queue, which this deployment has not configured",
        )
    # The worker refuses without it too, but a refusal that only exists inside a queued job is a
    # refusal nobody sees until they go looking. Said here, in the words the form can show.
    if not body.nuclei_hash:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "a marker map is built on a slide's nuclei — segment them first, so a phenotype is "
            "attributed to cells that already exist rather than to cells found a second time",
        )

    addressed = await _biomarker_address(biomarker_url, body.seg_hash, body.nuclei_hash)
    art_hash = addressed["art_hash"]
    scope = "region" if body.bbox is not None else "slide"
    params = {"bbox": body.bbox, "seg_hash": body.seg_hash, "nuclei_hash": body.nuclei_hash,
              "scope": scope}

    try:
        ack = await dispatch_run(
            plugin_url=plugin_url, kind="biomarker", item=item, art_hash=art_hash,
            params=params, token=token,
        )
    except DispatchUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return {"kind": "biomarker", "art_hash": art_hash, "status": "queued", "scope": scope,
            "girder_job_id": ack["jobId"]}


async def _biomarker_address(biomarker_url: str | None, seg_hash: str, nuclei_hash: str) -> dict:
    """What a marker map on these inputs would be called. Enqueues nothing.

    Asked of the service for the reason `_content_address` gives for the preprocess DAG: the store
    resolutions and the nucleus radius are deployment settings, they are in the hash, and a second
    copy of `artifacts.art_hash` here would be free to drift from the one the service stores under.
    """
    base = _need_biomarker(biomarker_url)
    try:
        async with httpx.AsyncClient(base_url=base, timeout=15.0) as client:
            resp = await client.post(
                "/biomarker/hash", json={"seg_hash": seg_hash, "nuclei_hash": nuclei_hash},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as exc:
        raise _map_error(exc) from exc


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
    cellvit_url: str | None = Depends(get_cellvit_url),
    plugin_url: str | None = Depends(get_plugin_url),
) -> dict:
    """Dispatch a nuclei run onto this box's queue (Inc 6 · 05). Writes no row.

    The first kind to move fully. Three things change and they are one change: the run becomes a
    Girder job rather than a call into the cellvit worker's own queue; the content address is
    computed *before* dispatch, because a dispatched run never comes back through the gateway; and
    **no artifact row is written here**, because under D9 a row is the claim that bytes exist on
    disk and at this moment none do. Until the last tile lands, this run is a job — visible in the
    Runs list, joined into the Workspace as a ghost row on the same `art_hash` — and the row is
    written when the driver reports (`report_artifact_result`).

    No `parent_hash`, even for a whole-slide run that names a `seg_hash`. Unlike the tissue and
    biomarker maps, a nucleus outline does not depend on a segmentation: the mask decides which
    tiles are worth the GPU, which is coverage, and deleting it later invalidates nothing here. It
    rides in `params` as provenance, not as a DAG edge — a delete of the segmentation is therefore
    not refused on this artifact's account, which is correct.
    """
    if not plugin_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "nuclei runs go on the Girder job queue, which this deployment has not configured",
        )
    # Checked here rather than left to the worker: it is the one refusal the caller can act on, and
    # a refusal that only exists inside a queued job is a refusal nobody sees until they go looking.
    if body.bbox is None and not body.seg_hash:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "a whole-slide run needs a tissue segmentation — segment the slide first so the job "
            "knows which tiles hold tissue",
        )

    addressed = await _nuclei_address(cellvit_url)
    art_hash = addressed["art_hash"]
    scope = "region" if body.bbox is not None else "slide"
    # Everything the service is asked for, which is also everything the row will record about how
    # this artifact was made — the driver reports these back verbatim.
    params = {"bbox": body.bbox, "seg_hash": body.seg_hash,
              "scope": scope, "backend": addressed.get("backend")}

    try:
        ack = await dispatch_run(
            plugin_url=plugin_url, kind="nuclei", item=item, art_hash=art_hash,
            params=params, token=token,
        )
    except DispatchUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return {"kind": "nuclei", "art_hash": art_hash, "status": "queued", "scope": scope,
            "backend": addressed.get("backend"), "girder_job_id": ack["jobId"]}


async def _nuclei_address(cellvit_url: str | None) -> dict:
    """What a nuclei run on this box would be called, and with which model. Enqueues nothing.

    The gateway does not compute the hash itself for the reason `_content_address` states for the
    preprocess DAG: a second copy of `artifacts.art_hash` is free to drift from the one the service
    stores under, and `conch_v1` is what that looks like when it happens.
    """
    base = _need_cellvit(cellvit_url)
    try:
        async with httpx.AsyncClient(base_url=base, timeout=15.0) as client:
            resp = await client.post("/nuclei/hash", json={})
            resp.raise_for_status()
            return resp.json()
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
    token: str | None = Depends(get_girder_token),
    tissue_url: str | None = Depends(get_tissue_url),
    plugin_url: str | None = Depends(get_plugin_url),
) -> dict:
    """Dispatch a tissue-map run onto this box's queue (Inc 6 · 06). Writes no row.

    Nuclei's shape from 05, with one difference that is the kind's own: a tissue map's parent
    **is** its segmentation, for both scopes. The mask is not merely which tiles were worth
    visiting — everything outside the contours is masked out of the raster, so the segmentation is
    in the content address and deleting it later would invalidate this map. The gateway records
    that edge when the driver reports (`_parent_of`).

    There is no `cancel` route beside this one any more. A run is a Girder job now, and Stop in the
    Runs list revokes the job; the driver forwards that to the tissue service's own cooperative
    stop. A second stop button addressing a row would be a second answer to the same question.
    """
    if not plugin_url:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "tissue maps go on the Girder job queue, which this deployment has not configured",
        )

    addressed = await _tissue_address(tissue_url, body.seg_hash, body.backend)
    art_hash = addressed["art_hash"]
    scope = "region" if body.bbox is not None else "slide"
    # `backend` as the service resolved it, not as it was asked for: an unnamed request lands on
    # this deployment's default, and the row has to say which model produced the numbers.
    params = {"bbox": body.bbox, "seg_hash": body.seg_hash, "scope": scope,
              "backend": addressed.get("backend")}

    try:
        ack = await dispatch_run(
            plugin_url=plugin_url, kind="tissue", item=item, art_hash=art_hash,
            params=params, token=token,
        )
    except DispatchUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return {"kind": "tissue", "art_hash": art_hash, "status": "queued", "scope": scope,
            "backend": addressed.get("backend"), "girder_job_id": ack["jobId"]}


async def _tissue_address(tissue_url: str | None, seg_hash: str, backend: str | None) -> dict:
    """What a tissue map with these params would be called, and with which model. Enqueues nothing.

    Asked of the service, not computed here, for the reason `_content_address` gives: which
    backends this box has and which one an unnamed request resolves to are deployment facts, both
    are in the hash, and a second copy of `artifacts.art_hash` would be free to drift.
    """
    base = _need_tissue(tissue_url)
    try:
        async with httpx.AsyncClient(base_url=base, timeout=15.0) as client:
            resp = await client.post(
                "/tissue/hash",
                json={"seg_hash": seg_hash, **({"backend": backend} if backend else {})},
            )
            resp.raise_for_status()
            return resp.json()
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
