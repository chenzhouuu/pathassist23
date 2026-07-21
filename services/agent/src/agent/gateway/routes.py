import asyncio
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..chat import EchoResponder, Responder
from ..claim import build_claim
from ..common.config import get_settings
from ..loop import AgentLoop, StubAgentLoop
from ..loop.artifacts import ArtifactStore, InMemoryArtifactStore
from ..loop.events import RunFinished
from ..loop.tools import ToolContext
from ..plan import Registry, load_registry, plan_digest, validate_plan
from ..plan.planner import Planner, StubPlanner
from ..run import invoke
from ..store import ConversationStore
from .auth import require_user
from .sse import sse_json

logger = logging.getLogger(__name__)

# Distinct base from the existing pathagent gateway (/api/agent) so the two coexist.
router = APIRouter(prefix="/api/copilot")

# The tool catalog is static config; load it once. Increments 7–8 swap the tools'
# implementations behind the same registry entries.
_REGISTRY: Registry = load_registry()


def get_store(request: Request) -> ConversationStore:
    """Resolve the process-wide ConversationStore set up by the app lifespan."""
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Copilot store unavailable")
    return store


def get_responder(request: Request) -> Responder:
    """Resolve the process-wide chat responder; fall back to echo if unset (tests)."""
    return getattr(request.app.state, "responder", None) or EchoResponder()


def get_planner(request: Request) -> Planner:
    """Resolve the process-wide planner; fall back to the deterministic stub if unset."""
    return getattr(request.app.state, "planner", None) or StubPlanner()


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
    """Append a grounding note so the model (and the echo double) can cite the ROI."""
    if not roi:
        return text
    return (
        f"{text}\n\n[Region of interest on the slide — {roi.get('kind', 'rect')} at "
        f"x={_num(roi['x'])}, y={_num(roi['y'])}, "
        f"width={_num(roi['width'])}px, height={_num(roi['height'])}px (image pixels).]"
    )


async def _iter_echo_tokens(text: str) -> AsyncIterator[tuple[str, str]]:
    """Yield (word, accumulated) pairs, pacing like a stream. Increment-2 swaps this
    for real Claude token streaming; the SSE frame contract stays put."""
    acc = ""
    for word in text.split():
        await asyncio.sleep(0.04)
        acc = f"{acc} {word}".strip()
        yield word, acc


# ── Plan compilation (increment 4) ───────────────────────────────────────────────


def _scope(conv: dict, roi: dict | None) -> dict:
    """The spatial scope a plan is grounded to: the active slide and any bound ROI."""
    return {"item_id": conv.get("item_id"), "roi": roi}


def _compile_steps(raw_steps: list[dict], registry: Registry) -> list[dict]:
    """Normalize planner output: sequential step numbers, registry category, candidate pool."""
    steps = []
    for i, s in enumerate(raw_steps, start=1):
        name = s.get("tool", "")
        tool = registry.get(name)
        steps.append({
            "n": i,
            "tool": name,
            "category": tool["category"] if tool else s.get("category"),
            "args": s.get("args") or {},
            "candidates": s.get("candidates") or [name],
        })
    return steps


def _envelope(steps: list[dict], registry: Registry) -> dict:
    """The cost/time envelope shown on the plan card, so the human gates with real info."""
    est, devices = 0, set()
    for s in steps:
        tool = registry.get(s["tool"])
        if tool:
            est += int(tool.get("est_seconds", 0))
            devices.add(tool.get("device", "cpu-stub"))
    device = devices.pop() if len(devices) == 1 else "mixed"
    return {"tools": len(steps), "est_seconds": est, "device": device, "mode": "research"}


def _plan_guidance(errors: list[str], scope: dict) -> str:
    """Turn a validation failure into a friendly next step instead of a broken card."""
    if not scope.get("roi") and any("roi" in e for e in errors):
        return ("To count or measure cells I need a region on the slide. Click the "
                "Region button, draw a box, then ask again.")
    return "I couldn't turn that into a runnable plan yet: " + errors[0]


@router.get("/health")
async def health() -> dict[str, str]:
    """Unauthenticated liveness probe. `chat` tells the UI which backend is live."""
    chat = "claude" if get_settings().anthropic_api_key else "echo"
    return {"status": "ok", "service": "copilot", "version": "0.6.2", "chat": chat}


@router.get("/tools")
async def list_tools(user: dict = Depends(require_user)) -> dict:
    """The tool catalog the planner draws from (increment 4)."""
    return {"tools": _REGISTRY.public()}


class EchoRequest(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/echo")
async def echo(body: EchoRequest, user: dict = Depends(require_user)) -> EventSourceResponse:
    """Stateless echo — the DB-free smoke path (README curl). The persisted flow is
    POST /conversations/{id}/messages; both share the same SSE token contract."""
    login = user.get("login") or _uid(user)

    async def event_stream():
        yield sse_json({"type": "start", "actor": login})
        acc = ""
        async for word, acc in _iter_echo_tokens(body.text):
            yield sse_json({"type": "token", "text": f"{word} ", "full": acc})
        yield sse_json({"type": "done", "text": acc})

    return EventSourceResponse(event_stream())


# ── Conversations (increment 1: persistence) ────────────────────────────────────


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
    conv["turns"] = await store.get_turns(conversation_id=conversation_id)
    conv["plans"] = await store.get_plans(conversation_id=conversation_id)
    conv["claims"] = await store.get_claims(conversation_id=conversation_id)
    # The case blackboard is per-slide (spans the user's threads on this slide), not
    # per-conversation — so it comes from (user, item), not conversation_id.
    conv["blackboard"] = await store.get_blackboard(user=_uid(user), item=conv.get("item_id"))
    return conv


class Roi(BaseModel):
    kind: str = "rect"
    x: float
    y: float
    width: float
    height: float
    unit: str = "px"


class MessageRequest(BaseModel):
    text: str = Field(..., min_length=1)
    roi: Roi | None = None


@router.post("/conversations/{conversation_id}/messages")
async def post_message(
    conversation_id: int,
    body: MessageRequest,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
    responder: Responder = Depends(get_responder),
    planner: Planner = Depends(get_planner),
) -> EventSourceResponse:
    """Persist the user turn, then either propose a plan or stream a chat reply.

    The user turn is saved *before* the response, so a reload shows it even if the
    stream is interrupted. The planner decides: a quantitative ask yields a validated,
    persisted **plan** (SSE `plan` frame — nothing runs until a human approves it);
    anything else streams from the Responder (Claude or echo). The SSE contract
    (start/token/done, plus error and now plan) is stable.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    login = user.get("login") or _uid(user)
    if not conv.get("title"):
        await store.set_title_if_empty(conversation_id=conversation_id, title=_snippet(body.text))
    roi = body.roi.model_dump() if body.roi else None
    turn_id = await store.add_turn(
        conversation_id=conversation_id, role="user", content=body.text, roi=roi
    )

    # Full history (incl. the turn just saved) is the model context; any ROI bound to a
    # turn is folded into that message so the model can cite its coordinates.
    turns = await store.get_turns(conversation_id=conversation_id)
    history = [{"role": t["role"], "content": _with_roi(t["text"], t.get("roi"))} for t in turns]
    scope = _scope(conv, roi)

    # ── Plan path: propose → validate → persist (nothing runs; a human gates it) ──
    # A planner failure must never break the turn — degrade to a plain chat reply.
    try:
        raw_plan = await planner.propose(
            text=body.text, history=history, scope=scope, registry=_REGISTRY
        )
    except Exception:  # noqa: BLE001 — any planner error falls back to chat
        logger.exception("planner.propose failed for conversation %s", conversation_id)
        raw_plan = None
    if raw_plan is not None:
        steps = _compile_steps(raw_plan.get("steps") or [], _REGISTRY)
        errors = validate_plan({"scope": scope, "steps": steps}, _REGISTRY)
        if not errors:
            digest = plan_digest(steps, scope, _REGISTRY.version)
            plan = await store.create_plan(
                conversation_id=conversation_id, turn_id=turn_id, digest=digest,
                steps=steps, scope=scope, envelope=_envelope(steps, _REGISTRY),
                reason=raw_plan.get("reason") or "",
            )

            async def plan_stream():
                yield sse_json({"type": "start", "actor": login,
                                "conversation_id": conversation_id})
                yield sse_json({"type": "plan", "conversation_id": conversation_id, **plan})
                yield sse_json({"type": "done", "conversation_id": conversation_id})

            return EventSourceResponse(plan_stream())

        # Invalid plan → a friendly next step (persisted), never a broken card.
        guidance = _plan_guidance(errors, scope)
        await store.add_turn(
            conversation_id=conversation_id, role="assistant", content=guidance
        )

        async def guide_stream():
            yield sse_json({"type": "start", "actor": login,
                            "conversation_id": conversation_id})
            acc = ""
            for word in guidance.split():
                acc = f"{acc} {word}".strip()
                yield sse_json({"type": "token", "text": f"{word} ", "full": acc})
            yield sse_json({"type": "done", "text": guidance,
                            "conversation_id": conversation_id})

        return EventSourceResponse(guide_stream())

    # ── Chat path: stream from the Responder, persist the assistant turn ──
    async def chat_stream():
        yield sse_json({"type": "start", "actor": login, "conversation_id": conversation_id})
        acc = ""
        try:
            async for chunk in responder.stream_reply(messages=history):
                acc += chunk
                yield sse_json({"type": "token", "text": chunk, "full": acc.strip()})
        except Exception as exc:  # noqa: BLE001 — surface any backend failure to the client
            logger.exception("chat stream failed for conversation %s", conversation_id)
            reply = acc.strip()
            if reply:
                await store.add_turn(
                    conversation_id=conversation_id, role="assistant", content=reply
                )
            yield sse_json({
                "type": "error",
                "message": f"The copilot backend failed mid-reply ({type(exc).__name__}).",
                "full": reply,
            })
            return
        reply = acc.strip()
        await store.add_turn(conversation_id=conversation_id, role="assistant", content=reply)
        yield sse_json({"type": "done", "text": reply, "conversation_id": conversation_id})

    return EventSourceResponse(chat_stream())


# ── Autonomous agent turn (R7/R8 — the SDK-loop seam) ────────────────────────────


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
    # The human's consent to run costly server tools on this (re-)turn — lifts the loop's
    # default permission gate (D2). The frontend sets it when the user approves a gated tool.
    approved: bool = False


@router.post("/conversations/{conversation_id}/turns")
async def post_turn(
    conversation_id: int,
    body: TurnRequest,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
    agent: AgentLoop = Depends(get_agent),
    artifacts: ArtifactStore = Depends(get_artifacts),
) -> EventSourceResponse:
    """Run one Claude-Code-style autonomous turn, streaming the typed event trace.

    The agent loop (a stub at R7, the Claude Agent SDK at R10) reasons, calls tools, and
    answers in a single turn — there is no separate plan/approve/run. It emits typed
    events (run · reasoning · tool_call · text) the frontend renders as a live trace with
    tool cards. The user turn is persisted *before* streaming and the assistant's final
    answer when the run finishes, so a reload survives an interrupted stream. This route
    coexists with the legacy /messages plan flow during migration.
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
    # a handle rides the stream (D4). The user's Girder token joins this context at R11.
    ctx = ToolContext(
        owner=_uid(user), conversation_id=conversation_id, artifacts=artifacts
    )

    async def turn_stream():
        final = ""
        try:
            async for ev in agent.run(
                text=body.text, history=history, scope=scope, viewer=viewer, ctx=ctx,
                approved=body.approved,
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
) -> dict:
    """Fetch a turn artifact's bulk geometry out-of-band by its handle `ref` (D4).

    Owner-scoped twice over: the conversation must be the caller's, and the store only
    returns the payload to the owner who wrote it. At R10/R11 the overlay fetches DSA
    annotations directly from Girder instead; this gateway path is the R9 stub.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    geometry = await artifacts.get(owner=_uid(user), ref=ref)
    if geometry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    return geometry


# ── Plan approval gate (increment 4) ─────────────────────────────────────────────


async def _transition_plan(
    store: ConversationStore, user: dict, conversation_id: int, digest: str, new_state: str
) -> dict:
    """Owner-scoped state transition for a plan: 404 if absent, 409 if not awaiting."""
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    existing = await store.get_plan(conversation_id=conversation_id, digest=digest)
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found")
    updated = await store.set_plan_state(
        conversation_id=conversation_id, digest=digest, state=new_state,
        expected=("AWAITING_APPROVAL",),
    )
    if updated is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Plan is not awaiting approval (state: {existing['state']}).",
        )
    return updated


@router.post("/conversations/{conversation_id}/plan/{digest}/approve")
async def approve_plan(
    conversation_id: int,
    digest: str,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> dict:
    """Freeze the plan as approved. Execution lands at increment 5; this only gates."""
    return await _transition_plan(store, user, conversation_id, digest, "APPROVED")


@router.post("/conversations/{conversation_id}/plan/{digest}/reject")
async def reject_plan(
    conversation_id: int,
    digest: str,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> dict:
    return await _transition_plan(store, user, conversation_id, digest, "REJECTED")


# ── Plan execution (increment 5) ─────────────────────────────────────────────────


@router.post("/conversations/{conversation_id}/plan/{digest}/run")
async def run_plan(
    conversation_id: int,
    digest: str,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> EventSourceResponse:
    """Execute an *approved* plan's steps, streaming per-step progress.

    Auto-run: the UI opens this stream as soon as approval succeeds. Each step is one
    stateless `invoke` (canned output at inc 5; real tools swap in at inc 7 unchanged).
    Bulk output (nuclei geometry) is not streamed — the `run_done` frame carries artifact
    handles the client fetches via GET .../runs/{id}/artifact/{key}, so this channel stays
    light when a real tool emits millions of cells.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    plan = await store.get_plan(conversation_id=conversation_id, digest=digest)
    if plan is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found")
    if plan["state"] != "APPROVED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Plan must be approved before it can run (state: {plan['state']}).",
        )
    # Content-addressed cache (increment 6b): an identical approved plan reuses the prior
    # run instead of recomputing — scoped to this user + slide by the plan digest.
    cached = await store.get_cached_run(
        user=_uid(user), item=conv.get("item_id"), plan_digest=digest)
    run = await store.create_run(conversation_id=conversation_id, plan_digest=digest)
    steps = plan.get("steps") or []
    scope = plan.get("scope")

    async def run_stream():
        yield sse_json({
            "type": "run_start", "run_id": run["id"], "conversation_id": conversation_id,
            "cached": cached is not None,
            "steps": [{"n": s["n"], "tool": s["tool"], "category": s.get("category")}
                      for s in steps],
        })
        artifacts: dict = {}
        values: dict = {}
        try:
            if cached is not None:
                # Reuse the prior result/artifacts, no re-invocation. Copy-on-hit keeps this
                # conversation's artifacts self-contained (get_artifact stays owner-scoped);
                # rung 7 swaps the copy for shared manifest refs when tools emit millions.
                values = cached.get("result") or {}
                artifacts = cached.get("artifacts") or {}
                for s in steps:
                    yield sse_json({"type": "run_step", "run_id": run["id"], "n": s["n"],
                                    "tool": s["tool"], "status": "done", "cached": True})
            else:
                for s in steps:
                    yield sse_json({"type": "run_step", "run_id": run["id"], "n": s["n"],
                                    "tool": s["tool"], "status": "running"})
                    await asyncio.sleep(0.3)  # let RUNNING show; real tools take much longer
                    res = invoke(s["tool"], s.get("args"), scope, artifacts)
                    artifacts.update(res.artifacts)
                    values.update(res.values)
                    yield sse_json({"type": "run_step", "run_id": run["id"], "n": s["n"],
                                    "tool": s["tool"], "status": "done",
                                    "produced": list(res.artifacts) + list(res.values)})
        except Exception as exc:  # noqa: BLE001 — surface any tool failure to the client
            logger.exception("run failed for conversation %s plan %s", conversation_id, digest)
            await store.finish_run(run_id=run["id"], status="FAILED", result=values,
                                   artifacts=artifacts, error=str(exc))
            yield sse_json({"type": "run_error", "run_id": run["id"],
                            "message": f"A tool failed while running ({type(exc).__name__})."})
            return
        await store.finish_run(run_id=run["id"], status="DONE", result=values,
                               artifacts=artifacts)
        # Build the durable, evidence-bound Claim (deterministic — the number comes from
        # the tool result, never the LLM) and persist it so it survives a reload.
        claim = build_claim(plan=plan, run_id=run["id"], values=values,
                            artifacts=artifacts, registry_version=_REGISTRY.version)
        saved = await store.create_claim(
            conversation_id=conversation_id, run_id=run["id"], claim=claim)
        # The new Claim updates the case blackboard; ship it so the memory strip refreshes
        # live without a reload (same per-slide projection as GET /conversations/{id}).
        blackboard = await store.get_blackboard(user=_uid(user), item=conv.get("item_id"))
        yield sse_json({
            "type": "run_done", "run_id": run["id"], "result": values,
            "artifacts": [{"key": k, "kind": a.get("kind", k)} for k, a in artifacts.items()],
            "claim": saved, "cached": cached is not None, "blackboard": blackboard,
        })

    return EventSourceResponse(run_stream())


@router.get("/conversations/{conversation_id}/runs/{run_id}/artifact/{key}")
async def get_run_artifact(
    conversation_id: int,
    run_id: int,
    key: str,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> dict:
    """Fetch a produced artifact (e.g. the nuclei geometry) — owner-scoped via the run's
    conversation. The opaque ArtifactRef is (run_id, key)."""
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    artifact = await store.get_artifact(
        conversation_id=conversation_id, run_id=run_id, key=key
    )
    if artifact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    return artifact


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
