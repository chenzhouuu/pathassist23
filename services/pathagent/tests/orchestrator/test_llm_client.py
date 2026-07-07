import json

import httpx
import pytest
import respx

CHAT_URL = "http://192.168.191.109:11500/chat"


def _client(**overrides):
    from pathagent.common.config import Settings
    from pathagent.orchestrator.llm_client import LLMClient

    return LLMClient(Settings(**overrides))


def _mock_text(text: str):
    """Register a /chat route returning the given assistant text."""
    return respx.post(CHAT_URL).mock(
        return_value=httpx.Response(
            200, json={"text": text, "usage": {"input_tokens": 1, "output_tokens": 1}}
        )
    )


@respx.mock
def test_complete_posts_exact_body_and_returns_text():
    route = _mock_text("hello world")

    result = _client().complete("sys", "hi")

    assert result == "hello world"
    assert route.called
    sent = json.loads(route.calls.last.request.content)
    assert sent == {
        "model": "gemma4",
        "system": "sys",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1024,
    }


@respx.mock
def test_complete_http_500_raises():
    from pathagent.orchestrator.llm_client import LLMError

    respx.post(CHAT_URL).mock(return_value=httpx.Response(500))

    with pytest.raises(LLMError):
        _client().complete("sys", "hi")


@respx.mock
def test_complete_connect_error_raises():
    from pathagent.orchestrator.llm_client import LLMError

    respx.post(CHAT_URL).mock(side_effect=httpx.ConnectError("boom"))

    with pytest.raises(LLMError):
        _client().complete("sys", "hi")


@respx.mock
def test_complete_json_plain_object():
    _mock_text('{"phiL": 0.8}')

    assert _client().complete_json("s", "u") == {"phiL": 0.8}


@respx.mock
def test_complete_json_fenced():
    _mock_text('```json\n{"a": 1}\n```')

    assert _client().complete_json("s", "u") == {"a": 1}


@respx.mock
def test_complete_json_surrounded_by_prose():
    _mock_text('Here is the answer: {"risk":"benign","depth":2} — done.')

    assert _client().complete_json("s", "u") == {"risk": "benign", "depth": 2}


@respx.mock
def test_complete_json_string_containing_braces():
    _mock_text('{"note":"see {this}","x":1}')

    assert _client().complete_json("s", "u") == {"note": "see {this}", "x": 1}


@respx.mock
def test_complete_json_no_object_raises():
    from pathagent.orchestrator.llm_client import LLMError

    _mock_text("sorry, cannot")

    with pytest.raises(LLMError):
        _client().complete_json("s", "u")


@respx.mock
def test_base_url_trailing_slash_stripped():
    route = respx.post("http://x:11500/chat").mock(
        return_value=httpx.Response(200, json={"text": "ok"})
    )

    result = _client(agent_llm_url="http://x:11500/").complete("s", "u")

    assert result == "ok"
    assert route.called
