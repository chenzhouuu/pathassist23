# Inc 2a — `describe_region` (Perceptor) — task-by-task TDD plan

> **Implements:** `2026-07-22-pathagent-v2-inc2-wsi-reasoning-tools-design.md` §3.0/§3.1 (the slice
> with **no index, no async**).
> **Status:** ✅ implemented locally (T1–T10, all suites green: pathvlm 20 + agent 104, ruff clean).
> The real MedGemma path (T6) is **deployed + GPU-smoke-verified** (2026-07-22): `google/medgemma-4b-it`
> at `/home/chen/data2/models/medgemma-4b-it`, `agent-pathvlm-1` on the A6000 (`/health` → `model:"medgemma"`,
> ~9.7G, ~13s/inference); a real TCGA-BRCA region reads at true 20× (small bbox) and drops to the
> output-cap mag (~3.4×) for a large bbox, exactly as §3.0 specifies. Commits `212c1da`→`61cb486`. Not pushed.
> **Shape:** stub-first, exactly like CellViT (R8 stub → R11 real). Build the *entire* path with a
> deterministic **stub Perceptor** so the service route, gateway client, tool, prompt, and browser
> E2E all work with no GPU; the real **MedGemma** lands behind the same seam and is deployed later
> (manual smoke, never CI).

## Conventions
- **Strict TDD:** each task is Red (failing test) → Green (minimal impl) → Commit. No task commits
  without a passing test *except* the two infra/model tasks (T1 scaffold, T6 real model) which are
  called out.
- **Conventional Commits**, subject ≤50 chars, English. Scopes: `pathvlm` (new service), `agent`
  (gateway). End each commit with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer.
- **Never commit** the dashboard WIP (`package*.json`, `src/components/dashboard/*`,
  `RightPanel/LeftSidebar/ViewerPanel.jsx`, `index.css`, `vite.config.js`, `src/test/`) or
  `.env`/secrets. **Do not push.**
- Run service tests from `services/pathvlm` and agent tests from `services/agent` with absolute
  `cd … && uv run pytest tests/…` (working-dir flips otherwise break the path).

## Contract (recap)
```
describe_region(bbox, magnification?: int, focus?: str) -> { description, magnification_used, mpp }
```
- Tools speak **objective power**; every request **clamps to native** (§3.0).
- Perceptor input constants (concrete, tunable): `PERCEPTOR_OUT_PX = 512`, `PERCEPTOR_DEFAULT_MAG = 20`
  (mirror `wsiAnalysis.js`'s 512 px @ 10× convention).
- Inc 2a is **summary-only** (`artifact=None`): the description rides the tool-result summary with
  provenance; the `regions` rectangle overlay is Inc 2c.

---

## Service side — `services/pathvlm/` (new)

### T1 — scaffold the Perceptor service  ·  `feat(pathvlm): scaffold Perceptor service`
*Infra (minimal test).* Create `services/pathvlm/{pyproject.toml, Dockerfile, .gitignore}` and
`src/pathvlm_service/{__init__.py, config.py}`. `config.py` reads `GIRDER_BASE`, `MEDGEMMA_CKPT`
(optional → stub), and the Perceptor constants. Mirror `services/cellvit/` layout.
- **Test:** `tests/test_config.py` — defaults load; missing `MEDGEMMA_CKPT` ⇒ `use_model is False`.
- **Green:** the config dataclass. `uv run pytest` green.

### T2 — magnification clamp + FOV math  ·  `feat(pathvlm): magnification clamp + FOV math`
Pure helpers in `perceptor.py`: `effective_magnification(native, requested) -> int` (clamp to native,
default when None) and `read_plan(native_mag, target_mag, out_px, bbox) -> (region_px, out_px, eff_mag)`
(the base-pixel region size + output cap + the effective mag actually delivered).
- **Test:** `tests/test_perceptor_contract.py` — 40× native + request 40 ⇒ eff 40; request 80 ⇒
  clamped 40; request None ⇒ default 20; a large bbox drives the output cap and lowers eff mag.
- **Green:** the two pure functions.

### T3 — magnification-aware region read  ·  `feat(pathvlm): magnification-aware region read`
`region.py::fetch_region_at_mag(...)`: GET `/item/{ref}/tiles` for native `magnification` + `mm_x`,
then GET `/tiles/region` with `units=base_pixels`, `left/top/regionWidth/regionHeight`, `magnification`
(clamped, from T2), and the output cap. Return `RegionImage(pixels, magnification_used, mpp)`. A
**separate reader** from CellViT's native-only `fetch_region`.
- **Test:** `tests/test_region.py` — `httpx.MockTransport` asserts the `/tiles` probe, then the
  `/region` call carries `magnification=<clamped>` + `units=base_pixels` + the output cap; token in
  the `Girder-Token` header, never a query param (D3).
- **Green:** the reader.

### T4 — stub Perceptor behind the model seam  ·  `feat(pathvlm): stub Perceptor behind model seam`
`infer.py::describe_array(pixels, magnification, focus) -> str`. Dispatch on `use_model`: stub returns
a deterministic canned morphology description that echoes `magnification` + `focus` (so E2E is
inspectable); the real MedGemma path is a guarded branch (T6), not run here.
- **Test:** `tests/test_infer.py` — stub is deterministic and mentions the mag + focus; dispatch calls
  the model path only when `use_model` (patched), else the stub.
- **Green:** stub + dispatch.

### T5 — `describe_region` route  ·  `feat(pathvlm): describe_region route`
`app.py`: `POST /describe_region` parses `{slide_ref, bbox, magnification?, focus?, girder_token}`,
validates bbox present + area ≤ cap (reuse the `_MAX_SEG_AREA` idea), calls the reader + `describe_array`,
returns `{description, magnification_used, mpp}`. 4xx on bad input.
- **Test:** `tests/test_describe_route.py` — inject a fake reader + describe (à la cellvit
  `test_segment_route`): 200 returns the description + `magnification_used`; missing bbox ⇒ 400;
  oversize bbox ⇒ 400.
- **Green:** the route.

### T6 — real MedGemma inference  ·  `feat(pathvlm): real MedGemma Perceptor inference`
*Model task (no CI; manual smoke).* Load **MedGemma** in `infer.py`'s guarded real branch via
`AutoModelForImageTextToText` + `AutoProcessor` (Gemma-3 chat format: image in the message content,
bfloat16) as a warm singleton (mirroring CellViT). Gate behind `use_model`; document the smoke command.
- **Verify:** manual — `MEDGEMMA_CKPT=… ` run one region, eyeball the description. Unit suite stays
  green (real branch not exercised).

---

## Gateway side — `services/agent/`

### T7 — Perceptor HTTP client  ·  `feat(agent): Perceptor HTTP client`
`pathvlm_client.py::describe_region(...) -> DescribeResult(description, magnification, mpp)`, async
httpx, generous timeout, token server-to-server (mirror `segmenter.py`).
- **Test:** `tests/test_pathvlm_client.py` — `MockTransport` returns a canned body; result maps
  fields; timeout/HTTP error surfaces as an exception the caller can degrade on.
- **Green:** the client.

### T8 — `describe_region` server tool  ·  `feat(agent): describe_region server tool`
Wire the tool through both seams:
- `tools.py`: add a `describe_region` `LoopTool` (SERVER) to `_TOOLS`; add `pathvlm_url` to
  `ToolContext`; add a `run_server_tool` branch — resolve region (model bbox → `scope.roi` → viewport,
  D8), area cap, call the client, build a **provenance summary** (F3): `"MedGemma at {mag}× on region
  (x,y): {description}"`; `artifact=None` (Inc 2a). Degrade to a clean summary if no `pathvlm_url`
  (stub context) or on client error.
- `sdk_tools.py`: add a `_SCHEMAS["describe_region"]` entry (`bbox`, `magnification`, `focus` with
  descriptions) — catalog auto-exposes the tool, but the typed schema must be added here or it falls
  back to a generic object.
- **Test:** `tests/test_tools_describe.py` — `run_server_tool` with an injected fake client returns the
  provenance summary + `ok`; no-URL context degrades gracefully; `sdk_tool_names()` now includes
  `mcp__pathagent__describe_region`.
- **Green:** the branch + schema.

### T9 — ground Perceptor output in the prompt  ·  `feat(agent): ground Perceptor output in prompt`
Extend `_SYSTEM` (`sdk.py`) with the F3 grounding clause (a Perceptor description is one model's
*hedged observation* of a region — attribute it, never upgrade it to a verdict or a diagnosis) and the
F5 "look before you drill" guidance (prefer a low-mag look before high-mag re-reads).
- **Test:** `tests/test_sdk.py` (or the existing prompt test) — assert the new clause substrings are
  present (mirrors Inc1's system-prompt assertion).
- **Green:** the prompt edit.

---

## Infra

### T10 — compose + gateway wiring  ·  `chore(pathvlm): compose + gateway wiring`
*Infra.* Add the `pathvlm` service to `docker-compose` (GPU, model volume, `GIRDER_BASE`), thread
`AGENT_PATHVLM_URL` into the gateway settings, and populate `ToolContext.pathvlm_url` where
`cellvit_url` is set today. Keep the stub path working when the URL is unset.
- **Verify:** `docker compose config` parses; a small settings test if the settings module is unit-
  testable; otherwise manual.

---

## Definition of done (Inc 2a)
- With **no** pathvlm service configured: `describe_region` degrades cleanly (stub/《no service》
  summary), suite green.
- With the **stub** service: end-to-end in the browser — Claude calls `describe_region` on a drawn ROI
  at a chosen magnification and relays a provenance-tagged description; no overlay yet (Inc 2c).
- With the **real** MedGemma deployed (T6): the description is a genuine morphology read at the
  (clamped) magnification, manually smoke-verified.
- All new unit suites green; `ruff` clean; nothing pushed; dashboard WIP untouched.

**Next after 2a:** Inc 2b (Navigator / whole-slide PLIP index) — gated on the R12 async task surface
(F2) — then Inc 2c (frontend `RegionOverlay` + trace panel + adaptive-mag animation).
