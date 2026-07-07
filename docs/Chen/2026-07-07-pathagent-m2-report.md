# PathAgent M2 — Classifier-Consensus Pass: Implementation & Verification Report

**Date:** 2026-07-07 · **Branch:** `chen` · **Service:** `services/pathagent`
**Milestone:** M2 (Plan 3 of the PathAgent series) — add the slide-level classifier-consensus pass
on top of M1 and verify it on real WSIs.

---

## 1. Executive summary

M2 is **implemented, reviewed (final holistic review: APPROVED, no must-fix), and verified
end-to-end on a real WSI.** After M1's backbone (`conch_v1`) features are cached, the worker now runs
a best-effort **consensus** pass (UNI `uni_v1`, 1024-dim) and calls the deployed **BRCA ABMIL**
classifier, storing a typed slide-level diagnosis + level-0 attention coordinates and flipping
`ready.classifiers`. The result is exposed at `GET /cases/{itemId}/classifier`.

Real-WSI run (BRACS_1648, all **12/12** checks passed):

| Artifact / signal | Value |
|---|---|
| Backbone features | `features_conch_v1.h5` (6290 × 512) |
| Consensus features | `features_uni_v1.h5` (**6290 × 1024**) |
| **BRCA prediction** | **ILC** — IDC 29.1% / ILC 70.9% (`ABMIL-BRCA-5fold-ensemble`, AUC 0.9624) |
| Attention | 50 top `top_coords`, all within level-0 `83664 × 64892` |
| Readiness | `status=ready`, `features=True`, `classifiers=True` |

Unit suite: **78 passing, ruff clean.**

---

## 2. Scope & honest boundaries

- **Delivered & verified:** the classifier-consensus pass (design φ_c) — consensus UNI extraction +
  the pluggable classifier client + `classifier.json` + `ready.classifiers` + the GET endpoint.
- **Pluggable, not hard-wired:** the only classifier-specific code is `ClassifierClient`; the BRCA
  ABMIL service is one backend behind a typed `predict() -> ClassifierResult`. This honors the
  design's pluggability and keeps the milestone from coupling to a single MIL model.
- **Best-effort:** backbone features remain the guaranteed artifact; a consensus/classifier failure
  is non-fatal (job still reaches `ready`, `classifiers=False`).
- **Deferred (not on this box):** the **SlideChat** LLM slide-reasoner is not claimed or integrated.
  The classifier is a **BRCA/UNI domain-specific** model (IDC vs ILC); broader cohorts need
  additional backends behind the same client.

---

## 3. What was built

| File | Change |
|---|---|
| `common/config.py` | `brca_service_url`, `classifier_enabled`, `classifier_timeout_s`, `default_consensus_encoder` |
| `common/schemas.py` | `ClassifierResult` (camelCase wire model: prediction/probs/num_patches/auc/top_coords/top_scores) |
| `common/cache_keys.py` | `CachePaths.classifier` → `classifier.json` |
| `worker/classifier_client.py` | `ClassifierClient.predict()` + `ClassifierError` (wraps HTTP, non-JSON, and schema-invalid bodies) |
| `worker/artifacts.py` | `copy_features()` — copy a consensus encoder's Trident h5 into the flat cache |
| `worker/trident_preprocess.py` | best-effort consensus + classifier stages; monotonic progress; stale-result cleanup; atomic write |
| `gateway/routes.py` | `GET /cases/{itemId}/classifier?cacheKey=` (auth; 400/404, never 500) |
| `scripts/m2_real_slide.py` | real-WSI verification (consensus + classifier) |

**Data flow:** `preprocess → backbone conch_v1 (M1) → [consensus uni_v1 Trident pass → copy_features
→ ClassifierClient.predict → classifier.json] → ready(features, classifiers)`. Cache keys already
vary by `consensus`, so M2 cases get distinct keys from M1 — no `PIPELINE_VERSION` bump. `top_coords`
are level-0 pixels consistent with the manifest geometry — ready for the M4 OSD attention overlay.

---

## 4. Verification results

**Unit tests:** `uv run pytest -q` → **78 passed**; `uv run ruff check .` → clean. New coverage:
classifier settings, `ClassifierResult` (camel/snake round-trip + minimal-payload contract),
`CachePaths.classifier`, the client (happy + HTTP-error + error-body + non-JSON + schema-invalid +
trailing-slash), `copy_features`, the worker's four best-effort cases (success / predict-raises /
consensus-subprocess-raises / no-consensus) + progress-monotonicity + stale-result cleanup, and the
endpoint (200 / 404-missing / 404-corrupt / 400-unsafe).

**Real-WSI end-to-end** (`scripts/m2_real_slide.py`, real Trident + real BRCA service): BRACS_1648 →
two Trident passes (conch_v1 512-dim, uni_v1 1024-dim) into one job dir → BRCA `/predict` on our own
freshly-extracted UNI features → `ILC 70.9%` with 50 in-bounds attention coords → `classifier.json`
written, `ready.classifiers=True`. All 12 assertions passed.

**Pre-build de-risk:** validated independently that (a) a second `uni_v1` Trident pass coexists in the
same job dir with the `conch_v1` pass (distinct `features_<encoder>/` subfolders), and (b) the BRCA
`/predict` accepts our own freshly-extracted UNI h5 (returned `ILC 70.9%`) — matching the integrated
run exactly.

---

## 5. Review process & issues found + fixed

Executed subagent-driven (fresh implementer per batch → spec + code-quality review → final holistic
review). Defects caught and fixed with regression tests:

| Sev | Issue | Fix |
|---|---|---|
| Important | Classifier client only caught `httpx.HTTPError`; `json`/pydantic errors escaped the `ClassifierError` contract | wrap non-JSON + `ValidationError` as `ClassifierError` |
| Important | Progress bar regressed `0.9 → 0.6 → 0.85` after inserting the new stages | backbone manifest stage → `0.5`; monotonic sequence + test |
| Minor | Stale `classifier.json` could survive a failed re-run | `unlink(missing_ok=True)` before the pass |
| Minor | Endpoint 500 on a corrupt/truncated `classifier.json` | parse guarded → 404; worker writes atomically (`.part` + `os.replace`) |
| Minor | Trailing slash in `brca_service_url` → `//predict` | `rstrip("/")` |

---

## 6. How to run

```bash
export HF_TOKEN=<hf_...>                       # gated CONCH/UNI weights
cd services/pathagent
# cache dir MUST be readable by the classifier service user (see §7)
mkdir -p /tmp/pathagent-m2-cache && chmod 755 /tmp/pathagent-m2-cache
uv run python scripts/m2_real_slide.py \
    --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs \
    --cache-dir /tmp/pathagent-m2-cache
```
A `PreprocessRequest` opts into the classifier by setting `consensus=FeatureSpec(patch_encoder="uni_v1", …)`.
Retrieve the result: `GET /api/agent/cases/{itemId}/classifier?cacheKey=…`.

---

## 7. Deployment note — classifier reads over shared filesystem

The BRCA ABMIL service (`:11501`) runs as a **different OS user** on the same host and reads the UNI
feature h5 by **path**. Therefore the cache dir (`PATHAGENT_CACHE_DIR`) and its created subdirs/files
must be **traversable + readable by that service user**. During verification a private scratchpad
(`/tmp/claude-*`, `drwx------`) caused the service to fail with HTTP 500 (permission), silently
leaving `classifiers=False`; a world-traversable cache dir (`0755` dirs, `0644` files, produced under
a `022`/`002` umask) resolved it. Enforce this in deploy config (shared group + umask, or an explicit
chmod) rather than relying on ambient umask.

---

## 8. Follow-ups (from the final holistic review — none blocking)

- **Item-level authorization** (carried from M1): `get_classifier`/`get_status` authenticate the
  Girder token but don't bind the caller to `itemId` (holder-of-`cacheKey` reads). Add an ownership
  check.
- **Cache-dir readability**: enforce the §7 requirement in deployment (or chmod the feature file to
  group/other-readable in the worker).
- **`default_consensus_encoder`** is currently dead config (consensus is fully request-driven) — wire
  it as a server-side fallback or drop it.
- **Naming**: the service emits `confidence/idc_prob/ilc_prob` as **percentages** (0–100), not 0–1
  probabilities — M4 must not re-scale.
- **Discoverability**: the consensus h5 isn't listed in `manifest.artifacts` (only the backbone is).

---

## 9. Commit log (this milestone)

```
2fa8f8d test(pathagent): add M2 real-WSI verification script (consensus + classifier)
8c88f67 fix(pathagent): monotonic progress, stale-result cleanup, robust classifier read
f6cb999 feat(pathagent): add GET classifier result endpoint
3c9356c feat(pathagent): run consensus + classifier passes in worker
ee46468 fix(pathagent): wrap all classifier failure modes as ClassifierError
ceacd3a feat(pathagent): add consensus feature copy helper
a101c10 feat(pathagent): add pluggable classifier client (BRCA ABMIL)
74ffcfa feat(pathagent): add classifier.json cache path
8705153 feat(pathagent): add ClassifierResult schema
2fb71aa feat(pathagent): add M2 classifier settings
4777b98 docs(plan): add PathAgent M2 classifier-consensus pass plan
```

## 10. Recommendation

M2 is complete and merge-ready. Next: either finish the branch (PR/merge M0–M2), or proceed to
**M3** — the LangGraph orchestrator that runs the merged agent loop over the cached M1 backbone +
M2 classifier signals (requires a reasoning-LLM key; keep it pluggable), followed by **M4** (the
React panel + OSD attention overlay, which consumes `classifier.json`'s level-0 `top_coords`).
