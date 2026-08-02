"""What a submission still has to run, and what each step will be called (Inc 6 · 07, plan D7).

The preprocess DAG is four kinds deep — segment, tile, encode, predict — and a slide usually has
some prefix of it already. Planning is therefore two questions asked in order:

1. **What would each step be called?** Every `art_hash` in this chain is computable from params and
   parent alone, never from output bytes (`preprocess_service/artifacts.py`). So the whole chain
   can be addressed before the first job starts, which is the fact the Celery chain rests on: no
   result has to flow from one link to the next, and each link can be submitted immutable.

2. **Which of them are missing?** Answered *backwards from the target*, not forwards. A step whose
   bytes exist is a step nobody needs to run, and that is true whether or not its own parent still
   exists — content addressing means the bytes are the artifact. Walking forwards would rebuild a
   patch grid in order to reach a feature index that is already on disk.

The hashes are not computed here. They are asked of the service that will produce them, through the
injected `address` callable, for the reason `_content_address` gives: a second copy of `seg_hash`
in the gateway would be free to drift from the one the worker uses, which is how `conch_v1` came to
mean two different embeddings.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

#: The chain, root first. Each kind's parent is the one before it.
ORDER = ("segmentation", "patching", "features", "prediction")

#: Which request field names a step's parent, per kind. The service's `/hash` takes the parent
#: under this name too, so one table serves both the addressing and the dispatch.
PARENT_KEY = {"patching": "seg_hash", "features": "patch_hash", "prediction": "feat_hash"}

#: What the Runs list calls each step. The chain's own label says what the submission was for.
TITLES = {
    "segmentation": "Tissue segmentation",
    "patching": "Tiling",
    "features": "Feature extraction",
    "prediction": "Downstream task",
}


@dataclass(frozen=True)
class Step:
    """One link: the address it will write to, and the call that writes it."""

    kind: str
    art_hash: str
    parent_hash: str | None = None
    #: What the service is called with **and** what the row records. One dict, because they had
    #: better be the same thing: the driver echoes these params back on the report that creates the
    #: row, so anything the address depends on has to be in here or the row cannot explain itself.
    #: That is why `impl` rides along — see `_SEG_PARAM_KEYS`.
    params: dict = field(default_factory=dict)

    def as_json(self) -> dict:
        """One element of the chain the dispatcher is handed."""
        return {"kind": self.kind, "artHash": self.art_hash, "params": self.params,
                "title": TITLES.get(self.kind, self.kind)}


Address = Callable[[str, dict], Awaitable[dict]]


async def address_chain(
    address: Address, target: str, params_by_kind: dict,
    *, known_parent: tuple[str, str] | None = None,
) -> list[Step]:
    """Name every step from the root of the DAG up to `target`, built or not.

    `params_by_kind` gives each kind its own request params, minus the parent — which is not the
    caller's to supply, because it is whatever the step before it turned out to be called.

    `known_parent` is `(kind, art_hash)`: a step somebody has named directly, so the chain starts
    after it. The steps above it are neither addressed nor planned, and that is the point — naming
    a feature index asserts it exists, and the params that would have produced it are then nobody's
    business. Without this, running a task on a chosen index would require reconstructing the
    segmentation params that index happened to be built with.
    """
    if target not in ORDER:
        raise ValueError(f"{target!r} is not a step of the preprocess chain")

    steps: list[Step] = []
    parent: str | None = None
    start = 0
    if known_parent is not None:
        kind, parent = known_parent
        if kind not in ORDER:
            raise ValueError(f"{kind!r} is not a step of the preprocess chain")
        start = ORDER.index(kind) + 1

    for kind in ORDER[start : ORDER.index(target) + 1]:
        request = dict(params_by_kind.get(kind) or {})
        key = PARENT_KEY.get(kind)
        if key:
            request[key] = parent
        addressed = await address(kind, request)
        art_hash = addressed["art_hash"]
        # The resolved params, not the requested ones: a segmenter left at its default and the
        # `impl` that produced the bytes are both part of the address and neither was typed by
        # anyone. The parent goes back in because that is how the service is called.
        resolved = dict(addressed.get("params") or request)
        if key:
            resolved[key] = parent
        steps.append(Step(kind=kind, art_hash=art_hash, parent_hash=parent, params=resolved))
        parent = art_hash
    return steps


def missing_suffix(steps: list[Step], have) -> list[Step]:
    """The steps that still have to run, given what this slide already holds.

    Walks back from the target and stops at the first step whose bytes exist. Everything collected
    on the way is what has to run, in order.
    """
    needed: list[Step] = []
    for step in reversed(steps):
        if step.art_hash in have:
            break
        needed.append(step)
    needed.reverse()
    return needed


async def plan(address: Address, *, target: str, params_by_kind: dict, have,
               known_parent: tuple[str, str] | None = None) -> list[Step]:
    """`address_chain` then `missing_suffix` — the whole planning question, in that order."""
    steps = await address_chain(address, target, params_by_kind, known_parent=known_parent)
    return missing_suffix(steps, have)


def satisfies_spec(rows: list[dict], feat_row: dict, spec: dict) -> bool:
    """Whether a features artifact is the build a task's weights were trained on.

    The encoder is on the features row; the tiling geometry is on its patching parent, so this
    walks one link up the DAG. `segmenter` is deliberately not compared: it propagates
    seg_hash → patch_hash → feat_hash, so requiring it would reject every otherwise-valid index and
    force a redundant rebuild. `FeatureSpec.matches` on the worker makes the same call — the two
    have to stay in step, which is why this comment repeats its reason rather than pointing at it.
    """
    if not spec or feat_row.get("kind") != "features":
        return False
    if (feat_row.get("params") or {}).get("encoder") != spec.get("encoder"):
        return False
    parent = next((r for r in rows if r.get("art_hash") == feat_row.get("parent_hash")), None)
    if not parent or parent.get("kind") != "patching":
        return False        # cannot verify the geometry ⇒ do not claim a match
    p = parent.get("params") or {}
    return all(
        _int(p.get(key)) == _int(spec.get(key))
        for key in ("mag", "patch_size", "overlap")
    )


def match_feature_spec(rows: list[dict], spec: dict) -> dict | None:
    """The ready features artifact a task can run on, or None."""
    return next((r for r in rows if satisfies_spec(rows, r, spec)), None)


def _int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default
