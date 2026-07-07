"""Dual-verification branches and the summary node for the M3 orchestrator.

Task 6 adds the three verifier branches -- internal consistency (``phi_l`` /
logic), factual alignment (``phi_k`` / knowledge), and consensus with the
classifier (``phi_c``) -- plus the ``summary`` node that composes the weighted
``phi_total`` and the final answer.

The three branches run in parallel in the graph (Task 7), so each writes its OWN
top-level state key (``phi_l`` / ``phi_k`` / ``phi_c`` plus ``citations`` /
``consensus_note``) instead of a shared ``scores`` key -- this avoids concurrent
writes to the same key. ``summary`` then reads those keys back and composes the
display ``scores`` and the ``final`` payload.

Same node contract as :mod:`.nodes`: ``fn(state, deps) -> partial dict`` and
never raise on a domain error -- only the specific :class:`LLMError` (plus
``TypeError`` / ``ValueError`` from coercing a bad JSON value) is caught.
"""

import logging

from ..common.schemas import VerifyScores
from .kb import fact_score
from .llm_client import LLMError
from .state import AgentState, Deps

logger = logging.getLogger(__name__)

_ICV_SYSTEM = (
    "You are a meticulous pathology reasoning auditor. Given a candidate diagnosis "
    "and the region-level findings that were gathered, judge the INTERNAL "
    "CONSISTENCY of the reasoning and whether the findings actually support the "
    "diagnosis. Reply with a single JSON object and nothing else: "
    '{"phiL": <number between 0 and 1>}, where 1 means fully self-consistent and '
    "well-supported and 0 means contradictory or unsupported."
)

_SUMMARY_SYSTEM = (
    "You are a breast-pathology attending writing the final sign-out. Given the "
    "candidate answers, the verification scores, and any consensus note, "
    "synthesize a single confident 2-3 sentence answer for the pathologist. Plain "
    "text only -- no JSON, no preamble."
)


def clamp01(x: float) -> float:
    """Clamp a value into the closed ``[0.0, 1.0]`` range."""
    return max(0.0, min(1.0, x))


def _chosen_answer(state: AgentState) -> str:
    """Return the answer currently under verification.

    Prefers the classifier candidate's answer when a classifier candidate is
    present, then the LLM candidate's answer, then the preliminary answer, then
    the empty string.
    """
    by_source: dict[str | None, dict] = {}
    for cand in state.get("candidates", []):
        if isinstance(cand, dict):
            by_source.setdefault(cand.get("source"), cand)
    for source in ("classifier", "llm"):
        cand = by_source.get(source)
        if cand is not None:
            return str(cand.get("answer", ""))
    return str(state.get("prelim", ""))


def _joined_findings(state: AgentState) -> str:
    """Join the findings of every visited region into one blob for the auditor."""
    parts = [
        str(desc.get("findings", "")).strip()
        for desc in state.get("descriptions", [])
        if isinstance(desc, dict)
    ]
    return " ".join(part for part in parts if part)


def _icv_user(answer: str, findings: str) -> str:
    """Render the internal-consistency prompt from the answer + gathered findings."""
    return (
        f"Candidate diagnosis: {answer or 'uncertain'}\n\n"
        f"Region findings gathered:\n{findings or '(none gathered)'}\n\n"
        'Return only {"phiL": <0..1>} rating internal consistency and evidence '
        "support."
    )


def icv(state: AgentState, deps: Deps) -> dict:
    """Score internal consistency + evidence validity (``phi_l``, 0..1).

    Asks the LLM to rate how self-consistent the chosen answer is against the
    findings gathered while navigating. Degrades to a neutral ``0.5`` on any LLM
    failure or unusable response (never raises).
    """
    answer = _chosen_answer(state)
    findings = _joined_findings(state)
    try:
        obj = deps.llm.complete_json(_ICV_SYSTEM, _icv_user(answer, findings))
        phi_l = clamp01(float(obj.get("phiL", obj.get("phi_l"))))
    except (LLMError, TypeError, ValueError):
        logger.warning("icv LLM failed; using neutral phi_l", exc_info=True)
        phi_l = 0.5
    return {"phi_l": phi_l}


def fact(state: AgentState, deps: Deps) -> dict:
    """Score factual alignment vs the knowledge base (``phi_k``, 0..1) + citations.

    Delegates to :func:`.kb.fact_score`, which already degrades safely to a
    neutral ``0.5`` and returns the citations regardless of the LLM outcome.
    """
    kb_hits = (state.get("nav") or {}).get("kb_hits", [])
    answer = _chosen_answer(state)
    phi_k, citations = fact_score(deps.llm, answer, kb_hits)
    return {
        "phi_k": phi_k,
        "citations": [citation.model_dump(by_alias=True) for citation in citations],
    }


def consensus(state: AgentState, deps: Deps) -> dict:
    """Score agreement with the independent classifier (``phi_c``, 0..1).

    The presence of a classifier candidate gates the branch. The classifier's
    answer is taken from ``deps.classifier['prediction']`` (falling back to the
    candidate's answer), and agreement is a case-insensitive substring match
    against the chosen answer. On agreement ``phi_c`` is the classifier's
    confidence; on disagreement it is capped low and a note is emitted. Without a
    classifier candidate the branch is neutral (``0.5``).
    """
    classifier_cand = next(
        (
            cand
            for cand in state.get("candidates", [])
            if isinstance(cand, dict) and cand.get("source") == "classifier"
        ),
        None,
    )
    if classifier_cand is None:
        return {
            "phi_c": 0.5,
            "consensus_note": "no consensus source (classifier unavailable)",
        }

    clf = deps.classifier or {}
    classifier_answer = str(clf.get("prediction") or classifier_cand.get("answer", ""))
    chosen = _chosen_answer(state)
    agree = (
        classifier_answer.lower() in chosen.lower()
        or chosen.lower() in classifier_answer.lower()
    )

    conf01 = 0.5
    if deps.classifier:
        try:
            conf01 = clamp01(float(deps.classifier.get("confidence", 50)) / 100.0)
        except (TypeError, ValueError):
            conf01 = 0.5

    if agree:
        return {"phi_c": conf01, "consensus_note": ""}
    return {
        "phi_c": max(0.0, min(0.3, 1.0 - conf01)),
        "consensus_note": (
            f"MLLM answer disagrees with classifier ({classifier_answer}); "
            "confidence lowered."
        ),
    }


def _phi_total(pairs: list[tuple[float | None, float]]) -> float:
    """Weighted mean of the present phi components, renormalized over their weights.

    Missing components (``None``) are excluded from both the numerator and the
    weight normalizer rather than being treated as ``0``. Returns a neutral
    ``0.5`` when no component is present or the present weights sum to zero.
    """
    present = [(phi, weight) for phi, weight in pairs if phi is not None]
    total_w = sum(weight for _, weight in present)
    if not present or total_w == 0:
        return 0.5
    return sum(weight * phi for phi, weight in present) / total_w


def _summary_user(
    state: AgentState, scores: dict, answer: str, consensus_note: str
) -> str:
    """Render the final-answer synthesis prompt from candidates + scores + note."""
    lines = [f"Chosen answer: {answer or 'uncertain'}", "", "Candidate answers:"]
    candidates = state.get("candidates", [])
    if candidates:
        lines.extend(
            f"- [{cand.get('source', '?')}] {cand.get('answer', '')}: "
            f"{cand.get('detail', '')}"
            for cand in candidates
        )
    else:
        lines.append("- (none)")
    lines += [
        "",
        (
            f"Scores: phiL={scores['phi_l']:.2f} phiK={scores['phi_k']:.2f} "
            f"phiC={scores['phi_c']:.2f} phiTotal={scores['phi_total']:.2f}"
        ),
    ]
    if consensus_note:
        lines.append(f"Consensus note: {consensus_note}")
    lines += ["", "Write the final 2-3 sentence answer as plain text."]
    return "\n".join(lines)


def summary(state: AgentState, deps: Deps) -> dict:
    """Compose ``phi_total``, the final answer, and the ``verify`` + ``final`` events.

    Reads the per-branch scores written by :func:`icv` / :func:`fact` /
    :func:`consensus` (any may be ``None`` if that branch did not run), computes
    the renormalized ``phi_total`` over the present branches, asks the LLM for a
    2-3 sentence final answer (templated fallback on failure), and returns the
    display ``scores``, the ``final`` payload, and the two stream events. Never
    raises on an LLM failure.
    """
    phi_l = state.get("phi_l")
    phi_k = state.get("phi_k")
    phi_c = state.get("phi_c")

    w_l, w_k, w_c = deps.settings.phi_weights
    phi_total = _phi_total([(phi_l, w_l), (phi_k, w_k), (phi_c, w_c)])
    scores = {
        "phi_l": phi_l if phi_l is not None else 0.5,
        "phi_k": phi_k if phi_k is not None else 0.5,
        "phi_c": phi_c if phi_c is not None else 0.5,
        "phi_total": phi_total,
    }

    answer = _chosen_answer(state)
    consensus_note = state.get("consensus_note", "")
    try:
        final_text = deps.llm.complete(
            _SUMMARY_SYSTEM, _summary_user(state, scores, answer, consensus_note)
        )
    except LLMError:
        logger.warning("summary LLM failed; using templated final answer", exc_info=True)
        final_text = (
            f"{answer} (confidence {round(100 * phi_total)}%). {consensus_note}"
        ).strip()

    confidence = round(100 * phi_total)
    trail = [
        {"x": r["x"], "y": r["y"], "width": r["width"], "height": r["height"]}
        for r in state.get("visited", [])
    ]
    citations = state.get("citations", [])
    final = {
        "answer": final_text,
        "confidence": confidence,
        "heatmapTaskId": state.get("task_id"),
        "trail": trail,
        "notes": consensus_note,
        "citations": citations,
    }

    verify_event = {
        "type": "verify",
        "scores": VerifyScores(
            phi_l=scores["phi_l"],
            phi_k=scores["phi_k"],
            phi_c=scores["phi_c"],
            phi_total=phi_total,
        ).model_dump(by_alias=True),
        "citations": citations,
    }
    final_event = {"type": "final", **final}
    return {"scores": scores, "final": final, "events": [verify_event, final_event]}
