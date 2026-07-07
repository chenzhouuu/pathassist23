"""Seed knowledge-base loader and fact-verification (phi_k) helpers.

Task 3 loads the bundled starter facts. Task 4 adds citation mapping and the
fact-alignment score used by the M3 verifier's knowledge branch.
"""

import json
from pathlib import Path

from ..common.schemas import Citation
from .llm_client import LLMClient, LLMError

_SEED_KB_PATH = Path(__file__).parent / "seed_kb.json"

_FACT_SYSTEM = (
    "You are a careful pathology fact-checker. You are given a candidate answer "
    "and a set of numbered reference snippets from a curated knowledge base. Judge "
    "how well the snippets support the candidate's factual claims. Reply with a "
    "single JSON object and nothing else: {\"phiK\": <number between 0 and 1>}, "
    "where 1 means the snippets fully support the candidate and 0 means they "
    "contradict it or offer no support."
)


def load_seed_kb() -> list[dict]:
    """Load the bundled seed knowledge-base entries.

    Returns:
        A list of ``{"id", "text", "source"}`` dicts parsed from
        ``seed_kb.json`` next to this module.
    """
    return json.loads(_SEED_KB_PATH.read_text())


def to_citations(kb_hits: list[dict]) -> list[Citation]:
    """Map perception KB hits to :class:`Citation` wire models.

    Each hit is shaped ``{"id", "text", "source", "score"}``. Malformed hits that
    are missing ``text`` or ``source`` are skipped rather than raising, so partial
    perception output never crashes the verifier.
    """
    citations: list[Citation] = []
    for hit in kb_hits:
        if not isinstance(hit, dict):
            continue
        text = hit.get("text")
        source = hit.get("source")
        if not text or not source:
            continue
        citations.append(Citation(text=text, source=source))
    return citations


def _build_fact_user(candidate: str, kb_hits: list[dict]) -> str:
    """Render the user prompt: candidate answer plus numbered KB snippets."""
    lines = [f"Candidate answer:\n{candidate}\n", "Reference snippets:"]
    for i, hit in enumerate(kb_hits, start=1):
        snippet = str(hit.get("text", "")).strip()
        source = str(hit.get("source", "")).strip()
        lines.append(f"{i}. {snippet} (source: {source})")
    lines.append(
        '\nReturn only {"phiK": <0..1>} = the degree the snippets support the candidate.'
    )
    return "\n".join(lines)


def fact_score(
    llm: LLMClient, candidate: str, kb_hits: list[dict]
) -> tuple[float, list[Citation]]:
    """Score factual alignment (phi_k, 0..1) of a candidate answer vs KB snippets.

    Asks the LLM to rate how well the candidate is supported by the retrieved
    snippets and returns ``(phi_k, citations)``. Degrades to a neutral ``0.5`` on
    any LLM failure or unusable response -- the citations are still returned
    (abstention, never raises).
    """
    citations = to_citations(kb_hits)
    if not kb_hits:
        return 0.5, []

    user = _build_fact_user(candidate, kb_hits)
    try:
        obj = llm.complete_json(_FACT_SYSTEM, user)
    except LLMError:
        return 0.5, citations

    raw = obj.get("phiK", obj.get("phi_k"))
    try:
        score = float(raw)
    except (TypeError, ValueError):
        return 0.5, citations

    score = max(0.0, min(1.0, score))
    return score, citations
