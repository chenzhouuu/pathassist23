#!/usr/bin/env python
"""M1 end-to-end verification on a REAL whole-slide image.

Runs the real Trident preprocess worker (resolve -> seg/coords/CONCH -> normalize ->
ready) on a local slide and asserts the cached artifacts are real and correct.

The registry is backed by fakeredis (M0 already proved the real Redis + RQ path); this
script's job is to prove the *real Trident pipeline* produces real CONCH features + a
correct manifest through the real worker code.

Usage (from services/pathagent, HF_TOKEN in env for gated CONCH weights):
    HF_TOKEN=... uv run python scripts/m1_real_slide.py \
        --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs
Exits non-zero on any failed check.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--slide-id", default="BRACS_1648.svs", help="filename under --slides-root")
    ap.add_argument("--slides-root", default="/home/chen/data2/BRCA-TEST")
    ap.add_argument(
        "--girder-item",
        default=None,
        help="Girder item id to fetch via the download resolver (bypasses --slides-root)",
    )
    ap.add_argument("--girder-base", default=None, help="Girder API base, e.g. http://host:9080/api/v1")
    ap.add_argument("--encoder", default="conch_v1")
    ap.add_argument("--mag", type=int, default=20)
    ap.add_argument("--patch-size", type=int, default=256)
    ap.add_argument("--cache-dir", default=None, help="defaults to a fresh temp dir")
    args = ap.parse_args()

    cache_dir = args.cache_dir or tempfile.mkdtemp(prefix="pathagent-m1-")
    os.environ["PATHAGENT_CACHE_DIR"] = cache_dir
    if args.girder_item:
        # Exercise the Girder-download resolver branch (no local slides_root).
        os.environ.pop("PATHAGENT_SLIDES_ROOT", None)
        if args.girder_base:
            os.environ["PATHAGENT_GIRDER_BASE"] = args.girder_base
    else:
        os.environ["PATHAGENT_SLIDES_ROOT"] = args.slides_root

    import fakeredis
    import h5py

    from pathagent.common import connection
    from pathagent.common.cache_keys import cache_paths, compute_cache_key
    from pathagent.common.config import get_settings
    from pathagent.common.registry import Registry
    from pathagent.common.schemas import FeatureSpec, JobStatus, Manifest, PreprocessRequest
    from pathagent.worker.trident_preprocess import run_trident_preprocess

    get_settings.cache_clear()
    connection.get_job_redis.cache_clear()
    fake = fakeredis.FakeStrictRedis(decode_responses=False)
    connection.get_job_redis = lambda: fake  # registry backing store for this run

    req = PreprocessRequest(
        backbone=FeatureSpec(patch_encoder=args.encoder, mag=args.mag, patch_size=args.patch_size)
    )
    item_id = args.girder_item or args.slide_id
    key = compute_cache_key(item_id, req)
    print(f"[m1] slide={item_id}  cache_key={key}")
    print(f"[m1] cache_dir={cache_dir}")
    print("[m1] running the REAL Trident worker (segmentation + CONCH; ~1-3 min on GPU)...")
    run_trident_preprocess(key, item_id, req.model_dump(by_alias=True))

    status = Registry(fake).get_status(key)
    paths = cache_paths(key)

    results: list[tuple[str, bool]] = []

    def check(name: str, cond: bool) -> bool:
        results.append((name, bool(cond)))
        return bool(cond)

    check("status == ready", status is not None and status.status == JobStatus.ready)
    check("ready.features is True", status is not None and status.ready.features)

    feat = paths.features(args.encoder)
    n = d = 0
    if check(f"features h5 exists ({feat.name})", feat.is_file()):
        with h5py.File(feat, "r") as f:
            n, d = (int(x) for x in f["features"].shape)
    check(f"features shape N>0 x 512 (got {n}x{d})", n > 0 and d == 512)
    check("coords.h5 exists", paths.coords.is_file())

    if check("manifest.json exists", paths.manifest.is_file()):
        m = Manifest.model_validate_json(paths.manifest.read_text())
        check(f"manifest.patchCount matches features ({m.patch_count})", m.patch_count == n)
        check(f"manifest.featureDim == 512 ({m.feature_dim})", m.feature_dim == 512)
        check(
            f"manifest level0 dims > 0 ({m.level0_width}x{m.level0_height})",
            m.level0_width > 0 and m.level0_height > 0,
        )
        print(
            f"[m1] manifest: slide={m.slide_name} targetMag={m.target_magnification} "
            f"baseMag={m.level0_magnification} patchSizeLevel0={m.patch_size_level0} "
            f"artifacts={sorted(m.artifacts)}"
        )

    print("\n[m1] ---- verification report ----")
    for name, ok in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    all_ok = all(ok for _, ok in results)
    print(f"[m1] {'ALL CHECKS PASSED' if all_ok else 'FAILURES PRESENT'}  ({cache_dir})")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
