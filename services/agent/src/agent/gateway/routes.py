import asyncio
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..store import ConversationStore
from .auth import require_user
from .sse import sse_json

# Distinct base from the existing pathagent gateway (/api/agent) so the two coexist.
router = APIRouter(prefix="/api/copilot")


def get_store(request: Request) -> ConversationStore:
    """Resolve the process-wide ConversationStore set up by the app lifespan."""
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Copilot store unavailable")
    return store


def _uid(user: dict) -> str:
    """The stable Girder user id used to scope ownership."""
    return str(user.get("_id") or user.get("login"))


def _snippet(text: str, limit: int = 48) -> str:
    """First line of a message, trimmed — used to auto-title a fresh conversation."""
    first = text.strip().split("\n", 1)[0].strip()
    return first[:limit] + ("…" if len(first) > limit else "")


async def _iter_echo_tokens(text: str) -> AsyncIterator[tuple[str, str]]:
    """Yield (word, accumulated) pairs, pacing like a stream. Increment-2 swaps this
    for real Claude token streaming; the SSE frame contract stays put."""
    acc = ""
    for word in text.split():
        await asyncio.sleep(0.04)
        acc = f"{acc} {word}".strip()
        yield word, acc


@router.get("/health")
async def health() -> dict[str, str]:
    """Unauthenticated liveness probe — handy for `curl` and container healthchecks."""
    return {"status": "ok", "service": "copilot", "version": "0.2.0"}


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
    return conv


class MessageRequest(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/conversations/{conversation_id}/messages")
async def post_message(
    conversation_id: int,
    body: MessageRequest,
    user: dict = Depends(require_user),
    store: ConversationStore = Depends(get_store),
) -> EventSourceResponse:
    """Persist the user turn, stream the (echo) reply, then persist the assistant turn.

    The user turn is saved *before* streaming, so a reload shows the message even if
    the stream is interrupted. Increment 2 replaces the echo body with Claude; the
    persist-around-stream shape stays.
    """
    conv = await store.get_conversation(user=_uid(user), conversation_id=conversation_id)
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    login = user.get("login") or _uid(user)
    if not conv.get("title"):
        await store.set_title_if_empty(conversation_id=conversation_id, title=_snippet(body.text))
    await store.add_turn(conversation_id=conversation_id, role="user", content=body.text)

    async def event_stream():
        yield sse_json({"type": "start", "actor": login, "conversation_id": conversation_id})
        acc = ""
        async for word, acc in _iter_echo_tokens(body.text):
            yield sse_json({"type": "token", "text": f"{word} ", "full": acc})
        await store.add_turn(conversation_id=conversation_id, role="assistant", content=acc)
        yield sse_json({"type": "done", "text": acc, "conversation_id": conversation_id})

    return EventSourceResponse(event_stream())


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
