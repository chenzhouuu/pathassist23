import logging

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..common.config import get_settings
from ..loop import AgentLoop, StubAgentLoop
from ..loop.artifacts import ArtifactStore, InMemoryArtifactStore
from ..loop.events import RunFinished
from ..loop.preprocess_client import get_job_status, trigger_preprocess
from ..loop.tools import ToolContext
from ..store import ConversationStore, SlideIndexStore
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


def get_slide_index_store(request: Request) -> SlideIndexStore:
    """Resolve the process-wide SlideIndexStore set up by the app lifespan."""
    store = getattr(request.app.state, "slide_index", None)
    if store is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Slide index unavailable")
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
        preprocess_url=preprocess_url,
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
