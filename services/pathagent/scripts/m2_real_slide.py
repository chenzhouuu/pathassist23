#!/usr/bin/env python
"""M2 end-to-end verification on a REAL whole-slide image.

Runs the full worker (backbone conch_v1 + consensus uni_v1 + BRCA ABMIL classifier) on a real
slide and asserts the cached artifacts + slide-level prediction are real and correct.

IMPORTANT: the cache dir must be readable by the classifier service process (a different OS user),
so pass a world-traversable --cache-dir (NOT a private scratchpad). The registry is fakeredis-backed
(M0/M1 already proved the real Redis + RQ path); this script proves the real consensus + classifier
pass produces a real ClassifierResult through the real worker code.

Usage (from services/pathagent, HF_TOKEN in env):
    HF_TOKEN=... uv run python scripts/m2_real_slide.py \
        --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs \
        --cache-dir /tmp/pathagent-m2-cache
"""
from __future__ import annotations

import argparse
import os
import sys


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
        ClassifierResult,
        FeatureSpec,
        JobStatus,
        Manifest,
        PreprocessRequest,
    )
    from pathagent.worker.trident_preprocess import run_trident_preprocess

    get_settings.cache_clear()
    connection.get_job_redis.cache_clear()
    fake = fakeredis.FakeStrictRedis(decode_responses=False)
    connection.get_job_redis = lambda: fake

    mag, ps = args.mag, args.patch_size
    req = PreprocessRequest(
        backbone=FeatureSpec(patch_encoder=args.backbone, mag=mag, patch_size=ps),
        consensus=FeatureSpec(patch_encoder=args.consensus, mag=mag, patch_size=ps),
    )
    item_id = args.girder_item or args.slide_id
    key = compute_cache_key(item_id, req)
    print(f"[m2] slide={item_id} cache_key={key} cache_dir={args.cache_dir}")
    print("[m2] running the REAL worker (conch_v1 + uni_v1 + BRCA ABMIL; ~3-5 min on GPU)...")
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

    if check("classifier.json exists", paths.classifier.is_file()):
        res = ClassifierResult.model_validate_json(paths.classifier.read_text())
        check(f"prediction in IDC/ILC (got {res.prediction})", res.prediction in {"IDC", "ILC"})
        check(f"0<=confidence<=100 (got {res.confidence})", 0.0 <= res.confidence <= 100.0)
        check(f"num_patches>0 (got {res.num_patches})", res.num_patches > 0)
        check(f"top_coords non-empty (got {len(res.top_coords)})", len(res.top_coords) > 0)
        if manifest is not None and res.top_coords:
            w, h = manifest.level0_width, manifest.level0_height
            in_bounds = all(0 <= x <= w and 0 <= y <= h for x, y in res.top_coords)
            check(f"top_coords within level0 {w}x{h}", in_bounds)
        print(
            f"[m2] PREDICTION: {res.prediction}  IDC={res.idc_prob}%  ILC={res.ilc_prob}%  "
            f"model={res.model}  patches={res.num_patches}"
        )

    print("\n[m2] ---- verification report ----")
    for name, ok in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    all_ok = all(ok for _, ok in results)
    print(f"[m2] {'ALL CHECKS PASSED' if all_ok else 'FAILURES PRESENT'}  ({args.cache_dir})")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
