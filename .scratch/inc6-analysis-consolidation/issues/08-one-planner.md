# 08 — One planner for every missing upstream

**What to build:** a single pure function that answers "what does this slide still need before this
tool can run", for every kind. It replaces `preprocessUtils.nextChainStep`,
`taskUtils.pendingStages`, and the hand-rolled checks in the biomarker and nuclei forms.

The form then says what it is about to do before it does it — "this slide still needs two
upstreams, 3 steps total" — and offers to submit the whole chain or only the part that can run now.

**Blocked by:** 07 — every kind has to be on the new path before one function can cover them all.

**Status:** done — verified on DEMO.

- [x] `plan(kind, params, rows)` → the ordered missing upstreams and their computed hashes. Pure,
      unit-tested against every kind, no network. **It lives in the gateway** — see below.
- [x] Every form's readiness statement is rendered from it. Four ad-hoc implementations are deleted,
      not left beside it.
- [x] The count of queue slots the submission will occupy is stated before submitting. Under
      `concurrency=1` this is a wait the user is agreeing to, so it is said out loud.
- [x] "Run everything" and "run only what can run now" are both offered; neither is a default that
      quietly costs hours of GPU.
- [x] **Verified on DEMO:** on a slide with nothing built, the marker-map entry states three steps;
      submitting runs them in order and the map appears at the end without a second click.

## What moved

```
gateway/plan.py    DEPENDS_ON        the DAG, as "before this can run" — with a `when`, for the
                                     one need that is conditional (a drawn region is its own mask)
                   Need / SCOPED_KINDS
                   address_run       name every step a run implies, upstream first
                   missing           mark backwards from the target
                   — ORDER, PARENT_KEY, missing_suffix (a chain walk cannot express two upstreams)
gateway/routes.py  _addresser        one address(kind, params), dialling whichever service owns it
                   _plan_and_dispatch  ?mode=run|plan|next
                   start_nuclei / start_tissue / start_biomarker  → the same planner
                   — _content_address, _nuclei_address, _tissue_address, _biomarker_address
                   — the three "run X first" refusals
plugin             — POST /pathassist/run, and `dispatch_run` with it
frontend           nativeCatalog.describePlan   the cost, in words
                   AnalysisPanel               a debounced `mode=plan` while the form is open,
                                               the numbered steps, and two buttons
                   firstProblem                keeps the two things a plan cannot supply
```

## Four calls worth not re-litigating

**The planner is server-side, and that is what makes it *one*.** The checkbox says "no network",
and the function has none — `address` is injected, and every test drives it with a double. What it
does need is the *addresses*, and those are the services' to compute: a fourth copy of a hash in
the browser is the `conch_v1` failure again, and 07 had just been bitten by a third copy inside
the service. So the form asks (`?mode=plan`) and renders the answer. The sentence in front of the
button and what the button does are then computed by the same function, which is the property that
matters — a client-side planner that agreed with the server today would be two things to keep in
step tomorrow.

**Needing something to run is not the same as being built from it.** Two tables, deliberately:
`DEPENDS_ON` (what must exist first) and `_PARENT_PARAM_BY_KIND` (lineage, which is what a delete
is refused over). They differ for nuclei — a whole-slide run names a segmentation to pick the tiles
worth the GPU, so it cannot start without one, but deleting those contours invalidates no nucleus.
Collapsing them would either refuse a legal delete or fail to refuse an illegal one.

**A marker map is why this is a DAG walk.** It needs two upstreams, so a chain walk cannot express
it at all. `missing` marks backwards from the target over each step's own `needs`, which also gives
the fork case for free: a map whose nuclei exist but whose contours do not, on a slide where the
map names those contours, plans one step.

**One submission, one segmentation.** Measured: a marker map that named its contours had a *second*
segmentation planned underneath it for the nuclei step, because a caller-supplied upstream was not
being recorded as resolved. The two would have been cut identically and one of them would have been
an hour of GPU. A named upstream now enters the resolution table like a planned one.

**An implicit upstream inherits the caller's scope.** A marker map over a rectangle needs nuclei
*in that rectangle*. Planning it whole-slide is either an hour nobody asked for or, if the region
is what gets run, a map that refuses at its first uncovered tile.

## What the runs showed (2026-08-02, DEMO and a bare slide)

```
Bare slide (TCGA-AR-A2LO, artifacts [])
  marker map, whole slide, mode=plan
    steps  Tissue segmentation → Nuclei segmentation → Marker map
    plan   all three, built: false

DEMO slide, in the browser
  Feature index, CONCH v1 text · 512 px
    "2 steps · 2 queue slots, one after another"
      1. Tiling
      2. Feature extraction
    [ Run everything ]  [ Run only tiling for now ]

  …change the segmenter to Otsu, and the plan re-reads itself:
    "3 steps · 3 queue slots, one after another"
      1. Tissue segmentation
      2. Tiling
      3. Feature extraction
    [ Run only tissue segmentation for now ]

  Tissue map, whole slide, default backend
    "Already built — nothing to run."   ← the reuse check, said rather than queued
```

The three-step build was then submitted for real and ran segment → tile → encode in order, as one
group in the Runs list.

## What did not come across

`POST /pathassist/run` and `dispatch_run` are gone. By the end of 07 nothing called them: the
planner always produces a sequence, and a sequence of one is a sequence. Keeping both would have
been two ways for a run to exist, and only one of them could reuse an artifact or plan an upstream
— which is the same reason 07 deleted segmentation's pre-01 path.
