"""Pluggable reasoning LLM client for the PathAgent M3 orchestrator."""

import json
import re

import httpx

from ..common.config import Settings


class LLMError(RuntimeError):
    """Raised when the reasoning LLM call fails or returns an unusable body."""


def _first_json_object(text: str) -> str | None:
    """Return the first balanced ``{...}`` substring, respecting string literals.

    Braces inside quoted strings do not affect depth counting, so values like
    ``"see {this}"`` are matched correctly.
    """
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _extract_json_object(text: str) -> dict | None:
    """Pull the first JSON object out of an LLM response.

    Handles responses wrapped in ```json ... ``` fences or surrounded by prose.
    Returns the parsed dict, or ``None`` if nothing parses.
    """
    candidates: list[str] = []
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fence is not None:
        candidates.append(fence.group(1))
    candidates.append(text)
    for candidate in candidates:
        snippet = _first_json_object(candidate)
        if snippet is None:
            continue
        try:
            obj = json.loads(snippet)
        except ValueError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


class LLMClient:
    """Reasoning LLM backend for M3 nodes (local ``/chat`` server)."""

    def __init__(self, settings: Settings) -> None:
        self._url = settings.agent_llm_url.rstrip("/")
        self._model = settings.agent_llm_model
        self._timeout = settings.agent_llm_timeout_s
        self._max_tokens = settings.agent_llm_max_tokens

    def complete(self, system: str, user: str) -> str:
        """POST a single user turn to ``/chat`` and return the assistant text."""
        body = {
            "model": self._model,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "max_tokens": self._max_tokens,
        }
        try:
            resp = httpx.post(f"{self._url}/chat", json=body, timeout=self._timeout)
            resp.raise_for_status()
            return str(resp.json()["text"])
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise LLMError(f"LLM call failed: {exc}") from exc

    def complete_json(self, system: str, user: str) -> dict:
        """Like :meth:`complete`, but parse the response into a JSON object."""
        text = self.complete(system, user)
        obj = _extract_json_object(text)
        if obj is None:
            raise LLMError("no JSON object in LLM response")
        return obj
