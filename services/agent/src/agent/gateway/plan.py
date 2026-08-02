"""What a submission still has to run, and what each step will be called (Inc 6 · 07–08, plan D7).

One planner, for every kind. It answers the question four different pieces of code used to answer
differently — `preprocessUtils.nextChainStep`, `taskUtils.pendingStages`, and the `required` /
`requiredWhen` marks on the nuclei and marker-map forms — and it answers it in one place because
the four answers were never the same shape and only one of them could reuse an artifact.

Planning is two questions asked in order:

1. **What would each step be called?** Every `art_hash` here is computable from params and parents
   alone, never from output bytes. So a whole submission can be addressed before the first job
   starts, which is the fact the Celery chain rests on: no result has to flow from one link to the
   next, and every link can be submitted immutable.

2. **Which of them are missing?** Marked backwards from the target. A step whose bytes exist is a
   step nobody needs to run, and so is everything that existed only to feed it — content addressing
   means the bytes *are* the artifact, so a hole below a built step is not refilled.

The hashes are not computed here. They are asked of the service that will produce them, through the
injected `address` callable, for the reason `_content_address` gives: a second copy of a hash in the
gateway would be free to drift from the one the worker stores under, which is how `conch_v1` came to
mean two different embeddings — and how, in 07, a feature index came to be addressed with one
version constant and written under another.

**Needing something in order to run is not the same as being built from it**, and the two tables
say so separately. `DEPENDS_ON` here is what must exist first; `_PARENT_PARAM_BY_KIND` in `routes`
is lineage, which is what a delete is refused over. Nuclei is where they differ: a whole-slide run
names a segmentation to pick the tiles worth the GPU, so it cannot start without one — but deleting
those contours invalidates no nucleus, so the nuclei artifact is not their child.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

#: What the Runs list calls each step. The submission's own label says what it was all for.
TITLES = {
    "segmentation": "Tissue segmentation",
    "patching": "Tiling",
    "features": "Feature extraction",
    "prediction": "Downstream task",
    "nuclei": "Nuclei segmentation",
    "tissue": "Tissue map",
    "biomarker": "Marker map",
}


@dataclass(frozen=True)
class Need:
    """An upstream a run cannot start without: the param that names it, and what kind it is."""

    param: str
    kind: str
    #: When the need applies at all, read off the run's own params. `None` means always. The one
    #: user is nuclei: a drawn region is segmented by its own rectangle, so only a whole-slide run
    #: needs the contours.
    when: Callable[[dict], bool] | None = None

    def applies(self, params: dict) -> bool:
        return self.when is None or bool(self.when(params))


def _whole_slide(params: dict) -> bool:
    return not params.get("bbox")


#: The DAG, as "before this can run". Order within a tuple is the order the steps are queued in.
DEPENDS_ON: dict[str, tuple[Need, ...]] = {
    "segmentation": (),
    "patching": (Need("seg_hash", "segmentation"),),
    "features": (Need("patch_hash", "patching"),),
    "prediction": (Need("feat_hash", "features"),),
    "tissue": (Need("seg_hash", "segmentation"),),
    "nuclei": (Need("seg_hash", "segmentation", when=_whole_slide),),
    # Two upstreams, which is why this is a DAG walk and not a chain walk. The segmentation bounds
    # the area the markers are inferred over; the nuclei are what the signal is attributed to.
    "biomarker": (Need("seg_hash", "segmentation"), Need("nuclei_hash", "nuclei")),
}

#: Kinds an implicit upstream inherits the caller's scope from. A marker map over a rectangle needs
#: nuclei *in that rectangle*, not over the whole slide — planning the upstream at the wrong scope
#: is either an hour of GPU nobody asked for or a run that refuses at the first uncovered tile.
SCOPED_KINDS = frozenset({"nuclei", "tissue", "biomarker"})


@dataclass(frozen=True)
class Step:
    """One link: the address it will write to, and the call that writes it."""

    kind: str
    art_hash: str
    parent_hash: str | None = None
    #: What the service is called with **and** what the row records. One dict, because they had
    #: better be the same thing: the driver echoes these params back on the report that creates the
    #: row, so anything the address depends on has to be in here or the row cannot explain itself.
    #: That is why `impl` rides along.
    params: dict = field(default_factory=dict)
    #: The addresses this step's own run needs — what marking works over.
    needs: tuple[str, ...] = ()

    def as_json(self) -> dict:
        """One element of the chain the dispatcher is handed."""
        return {"kind": self.kind, "artHash": self.art_hash, "params": self.params,
                "title": TITLES.get(self.kind, self.kind)}


Address = Callable[[str, dict], Awaitable[dict]]


class UnplannableRun(ValueError):
    """A kind this planner has no dependency table for. A caller mistake, not a service outage."""


async def address_run(address: Address, target: str, params_by_kind: dict) -> list[Step]:
    """Name every step a run of `target` implies, upstream first, built or not.

    `params_by_kind` gives each kind the params an **implicit** run of it would use; the target's
    own entry is the request itself. An upstream the caller named directly is not planned at all —
    naming a feature index asserts it exists, and reconstructing the segmentation params it happened
    to be built with would be work in service of a question nobody asked.
    """
    if target not in DEPENDS_ON:
        raise UnplannableRun(f"{target!r} is not a kind this planner knows")

    steps: list[Step] = []
    seen: dict[str, str] = {}

    async def resolve(kind: str, params: dict) -> str:
        request = dict(params)
        needs: list[str] = []
        for need in DEPENDS_ON.get(kind, ()):
            if not need.applies(request):
                continue
            if request.get(need.param):
                # Named by the caller — and recorded, so a *deeper* need for the same kind uses it
                # too. A marker map that names its contours must not have a second segmentation
                # planned underneath it for the nuclei step: one submission, one segmentation.
                seen.setdefault(need.kind, request[need.param])
                needs.append(request[need.param])
                continue
            if need.kind in seen:
                request[need.param] = seen[need.kind]
                needs.append(seen[need.kind])
                continue
            upstream = dict(params_by_kind.get(need.kind) or {})
            if need.kind in SCOPED_KINDS and "bbox" in request:
                upstream.setdefault("bbox", request.get("bbox"))
            parent = await resolve(need.kind, upstream)
            request[need.param] = parent
            needs.append(parent)

        addressed = await address(kind, request)
        art_hash = addressed["art_hash"]
        # The resolved params, not the requested ones: a segmenter left at its default and the
        # `impl` that produced the bytes are both part of the address and neither was typed by
        # anyone. The parents go back in because that is how the service is called.
        resolved = {**request, **(addressed.get("params") or {})}
        for need in DEPENDS_ON.get(kind, ()):
            if request.get(need.param):
                resolved[need.param] = request[need.param]
        steps.append(Step(kind=kind, art_hash=art_hash,
                          parent_hash=addressed.get("parent_hash"),
                          params=resolved, needs=tuple(needs)))
        seen[kind] = art_hash
        return art_hash

    await resolve(target, dict(params_by_kind.get(target) or {}))
    return steps


def missing(steps: list[Step], have) -> list[Step]:
    """The steps that still have to run, in the order they were planned.

    Marked backwards from the target: a step is needed when its own bytes are absent, and so is
    every step it depends on that is also absent. A step that exists only to feed one already on
    disk is dropped — bytes are the artifact, so the hole below it is not refilled.
    """
    if not steps:
        return []
    by_hash = {s.art_hash: s for s in steps}
    needed: set[str] = set()

    def mark(art_hash: str) -> None:
        if art_hash in have or art_hash in needed or art_hash not in by_hash:
            return
        needed.add(art_hash)
        for parent in by_hash[art_hash].needs:
            mark(parent)

    mark(steps[-1].art_hash)
    return [s for s in steps if s.art_hash in needed]


async def plan(address: Address, *, target: str, params_by_kind: dict,
               have) -> tuple[list[Step], list[Step]]:
    """`address_run` then `missing`, in that order.

    Returns `(everything, todo)`. Both, because the caller needs the target's address whether or not
    anything has to run — a submission with nothing left is answered with the artifact it already
    has rather than queued.
    """
    steps = await address_run(address, target, params_by_kind)
    return steps, missing(steps, have)


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
