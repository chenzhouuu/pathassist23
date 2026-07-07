#!/usr/bin/env python
"""M3 end-to-end verification on a REAL whole-slide image.

Runs the full M2 preprocessing worker (backbone conch_v1 + consensus uni_v1 + BRCA ABMIL
classifier) on a real slide, then drives the REAL M3 orchestrator graph
(:func:`pathagent.orchestrator.graph.run_query`) over the resulting cache and asserts the
streamed reasoning events, the composed verification scores, the final answer, and the
rendered importance heatmap are all real and internally consistent.

IMPORTANT: the cache dir must be readable by the classifier service process (a different OS
user), so pass a world-traversable --cache-dir (NOT a private scratchpad -- see the M2 report
§7). The registry is fakeredis-backed (M0/M1 already proved the real Redis + RQ path). The
orchestrator's reasoning LLM is the local server at ``settings.agent_llm_url`` (``:11500``,
model ``settings.agent_llm_model``), so that LLM server MUST be up for describe/diagnose/summary
to produce real output.

Usage (from services/pathagent, HF_TOKEN in env):
    HF_TOKEN=... uv run python scripts/m3_real_slide.py \
        --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs \
        --cache-dir /tmp/pathagent-m3-cache
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--slide-id", default="BRACS_1648.svs", help="filename under --slides-root")
    ap.add_argument("--slides-root", default="/home/chen/data2/BRCA-TEST")
    ap.add_argument("--girder-item", default=None, help="Girder item id (bypasses --slides-root)")
    ap.add_argument("--girder-base", default=None)
    ap.add_argument("--backbone", default="conch_v1")
    ap.add_argument("--consensus", default="uni_v1", help="consensus encoder for the classifier")
    ap.add_argument("--mag", type=int, default=20)
    ap.add_argument("--patch-size", type=int, default=256)
    ap.add_argument(
        "--cache-dir",
        required=True,
        help="world-traversable cache dir readable by the classifier service user",
    )
    ap.add_argument(
        "--question",
        default="What is the invasive carcinoma subtype and what features support it?",
    )
    args = ap.parse_args()

    os.environ["PATHAGENT_CACHE_DIR"] = args.cache_dir
    if args.girder_item:
        os.environ.pop("PATHAGENT_SLIDES_ROOT", None)
        if args.girder_base:
            os.environ["PATHAGENT_GIRDER_BASE"] = args.girder_base
    else:
        os.environ["PATHAGENT_SLIDES_ROOT"] = args.slides_root

    import fakeredis

    from pathagent.common import connection
    from pathagent.common.cache_keys import cache_paths, compute_cache_key
    from pathagent.common.config import get_settings
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import (
        AgentQueryRequest,
        ClassifierResult,
        FeatureSpec,
        JobStatus,
        Manifest,
        PreprocessRequest,
    )
    from pathagent.orchestrator.graph import run_query
    from pathagent.orchestrator.heatmap import read_meta
    from pathagent.orchestrator.llm_client import LLMClient
    from pathagent.orchestrator.perception import PerceptionRunner
    from pathagent.orchestrator.state import Deps
    from pathagent.worker.trident_preprocess import run_trident_preprocess

    get_settings.cache_clear()
    connection.get_job_redis.cache_clear()
    fake = fakeredis.FakeStrictRedis(decode_responses=False)
    connection.get_job_redis = lambda: fake

    # ── M2 preprocessing block (verbatim): run the real worker + assert its artifacts ──
    mag, ps = args.mag, args.patch_size
    req = PreprocessRequest(
        backbone=FeatureSpec(patch_encoder=args.backbone, mag=mag, patch_size=ps),
        consensus=FeatureSpec(patch_encoder=args.consensus, mag=mag, patch_size=ps),
    )
    item_id = args.girder_item or args.slide_id
    key = compute_cache_key(item_id, req)
    print(f"[m3] slide={item_id} cache_key={key} cache_dir={args.cache_dir}")
    print("[m3] running the REAL worker (conch_v1 + uni_v1 + BRCA ABMIL; ~3-5 min on GPU)...")
    run_trident_preprocess(key, item_id, req.model_dump(by_alias=True))

    status = Registry(fake).get_status(key)
    paths = cache_paths(key)
    results: list[tuple[str, bool]] = []

    def check(name: str, cond: bool) -> bool:
        results.append((name, bool(cond)))
        return bool(cond)

    check("status == ready", status is not None and status.status == JobStatus.ready)
    check("ready.features is True", status is not None and status.ready.features)
    check("ready.classifiers is True", status is not None and status.ready.classifiers)
    check("backbone features h5 exists", paths.features(args.backbone).is_file())

    import h5py

    consensus_h5 = paths.features(args.consensus)
    dim = 0
    if check("consensus features h5 exists", consensus_h5.is_file()):
        with h5py.File(consensus_h5, "r") as f:
            dim = int(f["features"].shape[1])
    check(f"consensus dim == 1024 (got {dim})", dim == 1024)

    manifest = None
    if paths.manifest.is_file():
        manifest = Manifest.model_validate_json(paths.manifest.read_text())

    clf_pred: str | None = None
    if check("classifier.json exists", paths.classifier.is_file()):
        res = ClassifierResult.model_validate_json(paths.classifier.read_text())
        clf_pred = res.prediction
        check(f"prediction in IDC/ILC (got {res.prediction})", res.prediction in {"IDC", "ILC"})
        check(f"0<=confidence<=100 (got {res.confidence})", 0.0 <= res.confidence <= 100.0)
        check(f"num_patches>0 (got {res.num_patches})", res.num_patches > 0)
        print(
            f"[m3] PREDICTION: {res.prediction}  IDC={res.idc_prob}%  ILC={res.ilc_prob}%  "
            f"model={res.model}  patches={res.num_patches}"
        )

    # ── M3 orchestrator drive: build deps + stream the reasoning graph ──
    # Production-faithful bridge: classifier.json is camelCase on disk; parse it through the
    # ClassifierResult schema and hand the graph the snake_case dict the nodes expect.
    classifier = (
        ClassifierResult.model_validate_json(paths.classifier.read_text()).model_dump()
        if paths.classifier.is_file()
        else None
    )

    settings = get_settings()
    deps = Deps(
        llm=LLMClient(settings),
        perception=PerceptionRunner(settings),
        settings=settings,
        classifier=classifier,
    )
    task_id = uuid.uuid4().hex
    req_q = AgentQueryRequest(
        item_id=item_id, cache_key=key, question=args.question, task="Diagnosis"
    )
    print(f"[m3] driving orchestrator graph (task_id={task_id}, llm={settings.agent_llm_model})...")

    async def _collect() -> list[dict]:
        out: list[dict] = []
        async for ev in run_query(req_q, deps, task_id):
            out.append(ev)
            print(f"[m3]   event: {ev.get('type')}")
        return out

    events = asyncio.run(_collect())

    # ── M3 assertions (the real-WSI orchestrator test) ──
    by_type: dict[str | None, list[dict]] = {}
    for ev in events:
        by_type.setdefault(ev.get("type"), []).append(ev)

    expected_types = {"route", "triage", "navigate", "describe", "diagnose", "verify", "final"}
    for et in sorted(expected_types):
        check(f"event type present: {et}", et in by_type)
    n_nav = len(by_type.get("navigate", []))
    n_desc = len(by_type.get("describe", []))
    check(f">=1 navigate event (got {n_nav})", n_nav >= 1)
    check(f">=1 describe event (got {n_desc})", n_desc >= 1)
    check("last event is final", bool(events) and events[-1].get("type") == "final")

    # navigate regions within level-0 bounds
    w = manifest.level0_width if manifest is not None else 0
    h = manifest.level0_height if manifest is not None else 0
    nav_events = by_type.get("navigate", [])
    if check("manifest loaded for bounds check", manifest is not None) and nav_events:
        def _in_bounds(region: dict) -> bool:
            x, y = region.get("x", -1), region.get("y", -1)
            return 0 <= x <= w and 0 <= y <= h

        all_in = all(_in_bounds(ev.get("region", {})) for ev in nav_events)
        check(f"all navigate regions within level0 {w}x{h}", all_in)

    # diagnose: classifier-source candidate must equal the classifier.json prediction
    diag_events = by_type.get("diagnose", [])
    diag_ev = diag_events[0] if diag_events else None
    has_cands = diag_ev is not None and bool(diag_ev.get("candidates"))
    if check("diagnose event has candidates", has_cands):
        cands = diag_ev.get("candidates", []) if diag_ev else []
        clf_cand = next((c for c in cands if c.get("source") == "classifier"), None)
        answer = clf_cand.get("answer") if clf_cand else None
        check(
            f"classifier candidate == classifier.json pred (cand={answer}, json={clf_pred})",
            clf_cand is not None and answer in {"IDC", "ILC"} and answer == clf_pred,
        )

    # verify: scores present, phiTotal in [0,1], real consensus phiC present
    ver_events = by_type.get("verify", [])
    ver_ev = ver_events[0] if ver_events else None
    if check("verify event present", ver_ev is not None):
        scores = ver_ev.get("scores", {}) if ver_ev else {}
        check(
            "verify scores keys phiL/phiK/phiC/phiTotal",
            all(k in scores for k in ("phiL", "phiK", "phiC", "phiTotal")),
        )
        phi_total = scores.get("phiTotal")
        check(
            f"0<=phiTotal<=1 (got {phi_total})",
            isinstance(phi_total, (int, float)) and 0.0 <= float(phi_total) <= 1.0,
        )
        check("phiC present (real consensus)", scores.get("phiC") is not None)

    # final: answer/confidence/trail/heatmapTaskId
    final_events = by_type.get("final", [])
    final_ev = final_events[-1] if final_events else None
    png = None
    if check("final event present", final_ev is not None):
        ans = final_ev.get("answer") if final_ev else None
        check("final answer is non-empty string", isinstance(ans, str) and bool(ans.strip()))
        conf = final_ev.get("confidence") if final_ev else None
        check(
            f"confidence int 0..100 (got {conf})",
            isinstance(conf, int) and 0 <= conf <= 100,
        )
        trail = final_ev.get("trail") if final_ev else None
        check(f"trail non-empty (got {len(trail) if trail else 0})", bool(trail))
        htid = final_ev.get("heatmapTaskId") if final_ev else None
        check(f"heatmapTaskId == task_id (got {htid})", htid == task_id)

        # heatmap PNG + extent metadata
        if htid:
            png = paths.heatmap(htid)
            if check("heatmap PNG exists", png.is_file()):
                check(f"heatmap PNG size>0 (got {png.stat().st_size})", png.stat().st_size > 0)
            meta_path = paths.heatmap_meta(htid)
            if check("heatmap meta exists", meta_path.is_file()):
                extent = read_meta(meta_path)
                ew, eh = extent.get("width", 0), extent.get("height", 0)
                check(f"heatmap extent width>0/height>0 (got {ew}x{eh})", ew > 0 and eh > 0)
                ex, ey = extent.get("x", -1), extent.get("y", -1)
                check(f"heatmap extent x,y within [0,{w}]/[0,{h}]", 0 <= ex <= w and 0 <= ey <= h)

    if final_ev is not None:
        print(f"[m3] FINAL answer: {final_ev.get('answer')!r}")
        print(
            f"[m3] FINAL confidence={final_ev.get('confidence')}  "
            f"trail_len={len(final_ev.get('trail') or [])}"
        )
    if ver_ev is not None:
        print(f"[m3] SCORES: {ver_ev.get('scores')}")
    if png is not None:
        print(f"[m3] heatmap: {png}")

    print("\n[m3] ---- verification report ----")
    for name, ok in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    all_ok = all(ok for _, ok in results)
    print(f"[m3] {'ALL CHECKS PASSED' if all_ok else 'FAILURES PRESENT'}  ({args.cache_dir})")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
