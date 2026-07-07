# PathAgent M1 — Trident Preprocessing Backbone: Implementation & Verification Report

**Date:** 2026-07-07 · **Branch:** `chen` · **Service:** `services/pathagent`
**Milestone:** M1 (Plan 2 of the PathAgent series) — replace the M0 fake preprocess worker with a real Trident pipeline and verify it on real whole-slide images.

---

## 1. Executive summary

M1 is **implemented, reviewed, and verified end-to-end on real WSIs.** The RQ worker now
resolves a slide, runs the real **Trident** pipeline (tissue segmentation → patch coordinates →
**CONCH `conch_v1`** patch features) as a subprocess in its own GPU conda env, normalizes the
output into the flat cache layout, and writes a typed manifest read from the real HDF5 geometry
attributes. The gateway/queue/registry contract from M0 is unchanged — only the worker function
behind `enqueue_preprocess` was swapped.

Two real slides were processed through two independent runtime paths; **all checks passed**:

| Path exercised | Slide | Patches × dim | Level-0 geometry | Outcome |
|---|---|---|---|---|
| Inline real worker (`scripts/m1_real_slide.py`) | BRACS_1648.svs | **6290 × 512** | 83664 × 64892 (base 40× → 20×) | ✅ all 9 checks |
| Real Redis + RQ worker + real Trident (async) | BRACS_1652.svs | **11455 × 512** | 67728 × 63004 | ✅ all 7 checks |

Unit suite: **54 passing, ruff clean.** Final holistic review: **APPROVED (merge-ready).**

---

## 2. Scope & honest boundaries

- **In scope and verified with real pixels:** the full worker pipeline — slide resolution
  (local-first), Trident subprocess (seg + coords + CONCH), artifact normalization, manifest,
  registry `ready` — plus the real Redis + RQ async path.
- **Implemented and unit-tested (respx-mocked) but not run against a live private item:** the
  **Girder download** resolver branch. The verified runs used the local `slides_root` resolver on
  on-disk slides. Running the remote path against a private Girder item additionally requires
  threading the caller's Girder token into the job (see §8 / M2).
- **Deliberately deferred to later milestones:** SlideChat / classifier passes (`ready.slidechat`,
  `ready.classifiers` remain `false`), query-conditioned navigation, the React panel, and the
  LangGraph orchestrator. `ReadyFlags(features=True, …)` reflects that only the feature pass exists.

---

## 3. What was built

New modules under `src/pathagent/`:

| Module | Responsibility |
|---|---|
| `common/config.py` (extended) | `trident_python`, `trident_repo`, `trident_gpu`, `seg_conf_thresh`, `default_overlap`, `slides_root`, `subprocess_timeout_s` — all `PATHAGENT_*`-overridable |
| `worker/girder_download.py` | `download_item_slide()` — pick largest WSI of a Girder item, stream atomically (`.part`→`os.replace`), filename sanitized |
| `worker/slide_resolver.py` | `resolve_slide()` — local `slides_root` first (validated + glob-escaped), else Girder |
| `worker/trident_runner.py` | `build_command()` + `run_trident()` — subprocess in the `pathology` conda env, log to `trident.log`, raise on nonzero/timeout |
| `worker/artifacts.py` | `normalize_and_manifest()` — locate Trident h5, read geometry from `coords.attrs`, copy to flat `CachePaths`, write typed `Manifest` |
| `worker/trident_preprocess.py` | `run_trident_preprocess()` — the swap target orchestrating resolve → seg → features → normalize → `ready` |
| `common/schemas.py` (extended) | `Manifest` (camelCase wire model) |

Wiring changes: `gateway/queue.py` enqueues `run_trident_preprocess`; `common/cache_keys.py`
bumps `PIPELINE_VERSION` **1 → 2** (invalidating all M0 stub caches); `pyproject.toml` adds
`h5py` (the only new gateway/worker dependency — heavy CV/ML deps stay isolated behind the
Trident subprocess). `fake_preprocess.py` is retained for fast inline demos/tests.

**Data contract (verified against a real run):** Trident writes
`JOB/{mag}x_{patch}px_{overlap}px_overlap/features_{enc}/NAME.h5` with datasets
`features (N,512) float32` + `coords (N,2) int64`, and `coords.attrs` carrying level-0 geometry
(`level0_width/height`, `level0_magnification`, `target_magnification`, `patch_size_level0`,
`overlap`). The manifest reads these attrs directly — **geometry is never hardcoded**, honoring the
design's level-0-pixel coordinate contract.

---

## 4. Verification results

**Unit tests:** `uv run pytest -q` → **54 passed**, `uv run ruff check .` → clean. New coverage:
config defaults/overrides, Girder download (largest-file pick, header, traversal-filename reject,
no-WSI reject, atomic `.part`), local resolver (direct/glob hits, glob-metachar reject, download
fallback), Trident runner (command construction, success/failure/timeout logging, HF env mirror),
Manifest camelCase round-trip, artifact normalization (synthetic h5 tree, malformed-h5 named
errors), worker happy/error paths, queue-enqueues-real-worker.

**Real-WSI inline run** (`scripts/m1_real_slide.py`, fakeredis-backed registry, real Trident):
BRACS_1648 → cache key `BRACS_1648.svs-53eb9c0bf957`; features `6290×512`; manifest
`patchCount=6290, featureDim=512, level0=83664×64892, targetMag=20, baseMag=40,
patchSizeLevel0=512`; artifacts `{coords, features, thumbnail, tissue}`; status `ready`. Wall time
under ~2 min on the A6000.

**Real Redis + RQ + Trident async run:** Redis 7 in Docker (:6380), `rq worker pathagent` (rq
2.10) in the gateway venv, job enqueued via `PreprocessQueue`. BRACS_1652 → key
`BRACS_1652.svs-36a538b6d07a`; observed `queued → running/segmentation → ready`; features
`11455×512`; manifest level0 `67728×63004`. This proves an RQ worker **child process** can drive
the real GPU Trident subprocess — the one integration M0 had exercised only with the fake worker.

---

## 5. Review process & issues found + fixed

Executed subagent-driven: fresh implementer per batch, then **spec-compliance** then
**code-quality** review, then a **final holistic** review. Defects caught and fixed (with
regression tests):

| Sev | Issue | Fix |
|---|---|---|
| Critical | Arbitrary file-write via attacker-controlled Girder filename (absolute/`..`) | basename + `_validate_segment` before join |
| Important | Glob injection / absolute-path in local resolver (`item_id="*"` → cross-case disclosure) | `_validate_segment(item_id)` + reject glob metachars + `glob.escape` |
| Important | Girder-download fallback branch untested | added monkeypatched fallback test |
| Minor | Timeout lost the `trident.log` | write log from `TimeoutExpired.stdout/stderr` before re-raise |
| Minor | Silent download of a non-WSI when no extension matched | raise `ValueError` |
| Minor | Non-atomic download left truncated files | stream to `.part` + `os.replace` |
| Minor | Cryptic error on malformed/empty Trident h5 | named `KeyError` + required-attr validation + tests |

Final review confirmed integration coherence, correctness, design fidelity, and clean secret
handling (HF token is env-only: never in `Settings`, argv, logs, manifest, or git).

---

## 6. How to run

Real Trident deps live in the `pathology` conda env
(`/home/chen/miniconda3/envs/pathology/bin/python`); the gateway/worker run in the `uv` venv.

```bash
# HF token for gated CONCH weights (do NOT commit it)
export HF_TOKEN=<hf_...>

# Inline real-WSI verification
cd services/pathagent
uv run python scripts/m1_real_slide.py \
    --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs

# Async (production) path
export PATHAGENT_REDIS_URL=redis://localhost:6380/0
export PATHAGENT_SLIDES_ROOT=/home/chen/data2/BRCA-TEST
export PATHAGENT_CACHE_DIR=/tmp/pathagent-cache
docker run -d --rm --name pa-redis -p 6380:6379 redis:7
uv run rq worker pathagent --url "$PATHAGENT_REDIS_URL"   # in one shell
# then enqueue via PreprocessQueue / the gateway route
```

Key `PATHAGENT_*` overrides: `SLIDES_ROOT`, `CACHE_DIR`, `REDIS_URL`, `TRIDENT_PYTHON`,
`TRIDENT_REPO`, `TRIDENT_GPU`, `DEFAULT_OVERLAP`, `SEG_CONF_THRESH`, `SUBPROCESS_TIMEOUT_S`.

---

## 7. Environment (this machine)

- GPU: **RTX A6000, 48 GB** (idle at rest). A single BRACS slide (seg + CONCH over 6k–11k
  patches) completes in ~1–2 min.
- Trident: `/home/chen/MIL-Lab/trident` (`run_single_slide.py`), torch 2.10+cu128 in env `pathology`.
- Weights: seg (`~/.cache/trident`), CONCH + UNI (`~/.cache/huggingface`) already present.
- Slides: `/home/chen/data2/BRCA-TEST` (BRACS), plus TCGA-BRCA/NSCLC/CPTAC corpora.

---

## 8. Security finding — tracked `.env.local` (action required, not an M1 code defect)

The M1 committed diff contains **no secrets**. However, the repo-root **`.env.local` is
git-tracked** (it was committed before being added to `.gitignore`, so `.gitignore` no longer
protects it), and the working-tree copy contains a **live HF token**. The token has **never
entered git history** (verified: `git log --all -S` finds nothing; `HEAD:.env.local` holds only
commented placeholders), so there is nothing to remediate in history — but a future
`git add -A`/`git commit -am` would commit the live token.

**Recommended action (safe, reversible, keeps the file on disk):**
```bash
git rm --cached .env.local        # untrack; .gitignore then takes effect
git commit -m "chore: stop tracking .env.local (secrets must not be tracked)"
# optional precaution: rotate the HF token if it was ever shared/exposed
```
All PathAgent commits in this milestone were staged file-by-file and never included `.env.local`.

---

## 9. Deferred / prerequisites for M2

Genuine gaps, correctly out of M1 scope, to address next:
- **Item-level authorization:** `require_user` authenticates the Girder token but does not check
  the caller may access `itemId` (IDOR). Add a per-item permission check before preprocess/status.
- **Girder token → worker:** thread the caller's token through `enqueue_preprocess` into
  `resolve_slide` so the remote-download path works for private items (currently anonymous).
- **Ingress encoder validation:** add a `FeatureSpec` allowlist/validator so the encoder path
  segment is validated at the API boundary, not only inside `CachePaths.features()`.
- **Retention/cleanup:** prune raw downloads, the Trident `job_dir` tree, and stale
  `PIPELINE_VERSION` cache dirs.
- **Minor:** verify on-disk artifacts still exist before trusting a `ready` status; de-dup
  in-flight duplicate requests for the same cache key.

---

## 10. Commit log (this milestone)

```
d040dfb test(pathagent): add M1 real-WSI end-to-end verification script
e39ea57 fix(pathagent): clear errors for malformed Trident h5; use PIPELINE_VERSION in test
30b71cc feat(pathagent): swap queue to real Trident worker; bump pipeline version to 2
dc4caeb feat(pathagent): add real Trident preprocess worker
14a837f feat(pathagent): add Trident artifact normalization + manifest builder
ef81940 chore(pathagent): add h5py for reading Trident h5 outputs
dec5fa3 fix(pathagent): harden slide download/resolve against path & glob injection
6626257 feat(pathagent): add Manifest schema
caa970b feat(pathagent): add Trident subprocess runner
da76192 feat(pathagent): add slide resolver (local-first) + Girder downloader
ca51873 feat(pathagent): add M1 Trident/slide settings
4e8947e docs(plan): add PathAgent M1 Trident preprocessing backbone plan
```

## 11. Recommendation

M1 is complete and merge-ready. Before the branch takes further commits, untrack `.env.local`
(§8). Then either finish the branch (PR/merge) or proceed to **M2** — starting with item-level
authorization and Girder-token plumbing so the remote slide path is production-safe, followed by
the SlideChat/classifier passes.
