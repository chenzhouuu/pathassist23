# PathAgent M3 — Orchestrator (Diagnosis-only merged loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the M3 orchestrator to PathAgent — the merged **PathFinder × WSI-Agents** loop
(`router → triage → (navigate ⇄ describe)* → diagnose → {icv ∥ fact ∥ consensus} → summary`) exposed
as `POST /api/agent/query` (SSE), streaming all seven typed events, backed by **real signals on a
real WSI**: query-conditioned CONCH concept-similarity navigation + a zoomable heatmap, the M2
classifier consensus (φ_c), a shipped seed KB (φ_k + citations), and a pluggable local reasoning LLM.

**Architecture:** LangGraph cyclic graph runs inside the FastAPI gateway process. Reasoning nodes call
a **pluggable LLM client** (`POST http://192.168.191.109:11500/chat`, MedGemma/Gemma via Ollama —
the design-sanctioned swap for GPT-4V). The one heavy-ML step — query-conditioned CONCH
concept-similarity over the cached `conch_v1` features (+ seed-KB retrieval, + the importance raster)
— runs as a **subprocess in the `pathology` conda env** (mirrors M1's `trident_runner`), so torch/conch
never enter the gateway venv. φ_c reuses the cached `classifier.json` from M2. The heatmap raster is
served as an OSD-addable image tile at its level-0 extent.

**Tech Stack:** FastAPI · LangGraph · sse-starlette · Pydantic v2 (`CamelModel`) · httpx · numpy ·
Pillow · h5py · CONCH (`conch.open_clip_custom`, in the `pathology` env) · pytest + respx.

---

## Honest scope (what is real vs. deferred)

**Real, computed on a real WSI (the M3 deliverable):**
- The full LangGraph merged loop with the navigate⇄describe cycle + budget/termination.
- **Navigation** = query-conditioned CONCH concept-similarity over the **real cached `conch_v1`
  features** → top hotspot regions + coverage samples, as **level-0 pixel** rects (from Trident
  `coords` attrs). Advisory guidance only — decides *where to look*, never the answer.
- **Heatmap** = the concept-similarity importance raster over the patch lattice → a PNG at its
  level-0 extent, served by `GET /api/agent/cases/{itemId}/heatmap/{taskId}` (OSD `addTiledImage`).
- **φ_c (consensus)** = agreement of the diagnosed subtype vs the **real M2 `classifier.json`**.
- **φ_k (fact)** = retrieval over a shipped **seed KB** (curated breast-pathology snippets) → real
  citations + an LLM factual-alignment score.
- **φ_l (ICV)** = an LLM logic judge over the candidate's claims/evidence.
- All reasoning (router/triage/describe/diagnose/judges/summary) via the **pluggable LLM client**
  (default local `gemma4`; `medgemma` swap by config).

**Deferred / pluggable (documented, not faked):**
- **SlideChat** slide-level candidate generator — not deployed on this box. v1 candidate generators =
  (a) the classifier consensus, (b) the LLM over navigated evidence. SlideChat is the deferred third.
- **GPT-4V** reasoning — replaced by the local LLM via the pluggable client (design §2/§11 sanction).
- **Full WHO + PathologyOutlines KB** — replaced by the extensible seed KB (design's M2a KB was never
  built on this box).
- **Live OSD viewport co-navigation, pause/take-control, provenance annotations** — that is **M4**
  (frontend). M3 emits the events + heatmap tile that M4 will replay.
- **Morphology / Treatment / Report tasks** — **M3b**. v1 = **Diagnosis only** (design decision #9).
- **Durable checkpointer / redirect-resume** — v1 in-memory (design §13.2). Pause-only is M4.

---

## Wire contract (from design §6, level-0 px per §13.1)

```
POST /api/agent/query                              (SSE stream; auth = Girder token)
  body: AgentQueryRequest { itemId, cacheKey, task?:"auto"|"Diagnosis"="auto",
                            question, roi?:{x,y,width,height} }
  → text/event-stream, one JSON object per SSE `data:` line:
      {type:"route",    task, tools:[...]}
      {type:"triage",   risk, depth, maxRegions}
      {type:"navigate", region:{x,y,width,height}, zoom, rationale}   # 0..maxRegions of these
      {type:"describe", region:{...}, findings}
      {type:"diagnose", candidates:[{source, answer, detail}]}
      {type:"verify",   scores:{phiL,phiK,phiC,phiTotal}, citations:[{text,source}]}
      {type:"final",    answer, confidence, heatmapTaskId, trail:[{x,y,width,height}], notes}
      {type:"error",    message}                                       # terminal on failure

GET /api/agent/cases/{itemId}/heatmap/{taskId}     (auth)
  → image/png (importance raster) + headers X-Level0-X/Y/Width/Height (level-0 extent for OSD)
```
All `region`/`roi`/heatmap geometry is **level-0 (base) image pixels** (design §13.1). `taskId` is the
per-query id minted by the endpoint and echoed in `final.heatmapTaskId`.

---

## File structure

```
services/pathagent/
├── pyproject.toml                         # + langgraph, sse-starlette, numpy, pillow
├── src/pathagent/
│   ├── common/
│   │   ├── config.py                      # + agent_* settings
│   │   ├── cache_keys.py                  # + CachePaths.heatmap(task_id) / heatmap_meta(task_id)
│   │   └── schemas.py                     # + AgentQueryRequest, ROI, AgentEvent payloads
│   ├── orchestrator/                      # NEW package
│   │   ├── __init__.py
│   │   ├── llm_client.py                  # pluggable LLM (:11500/chat) — complete()/complete_json()
│   │   ├── perception.py                  # PerceptionRunner: subprocess wrapper → NavResult
│   │   ├── perception_subprocess.py       # runs in `pathology` env (CONCH text tower)
│   │   ├── kb.py                          # seed-KB retrieval consumption + φ_k helper
│   │   ├── seed_kb.json                   # shipped curated breast-pathology snippets
│   │   ├── state.py                       # AgentState TypedDict + event dataclasses/helpers
│   │   ├── nodes.py                       # router/triage/navigate/describe/diagnose nodes
│   │   ├── verify.py                      # icv/fact/consensus branches + summary
│   │   ├── heatmap.py                     # raster PNG read/write + level-0 extent meta
│   │   └── graph.py                       # build_graph() + run_query() async generator of events
│   └── gateway/
│       └── routes.py                      # + POST /query (SSE), + GET heatmap
├── scripts/
│   └── m3_real_slide.py                   # real-WSI end-to-end verification
└── tests/orchestrator/                    # unit tests per module
```

---

## Conventions (match existing code)
- Wire models subclass `CamelModel` (camelCase out, snake/camel in); `populate_by_name=True`.
- Heavy ML isolated in a subprocess launched with `settings.trident_python` (the `pathology` env);
  the gateway venv stays torch-free. Mirror `worker/trident_runner.py` (env mirroring, timeout,
  log capture, JSON-on-stdout contract).
- Typed error containment like `ClassifierClient`: each external call wraps its failure modes in one
  domain error type; nodes degrade gracefully (a failed branch lowers a score / abstains, never 500s
  the stream — the design's abstention-as-a-feature, §11).
- ruff: line-length 100, rules E,F,I,B,UP,BLE. `# noqa: BLE001` only on intentional best-effort.
- Level-0 pixels everywhere across the wire (§13.1).

---

## Task 1 — Deps, config, cache paths, wire schemas

**Files:**
- Modify: `pyproject.toml` (dependencies)
- Modify: `src/pathagent/common/config.py`
- Modify: `src/pathagent/common/cache_keys.py`
- Modify: `src/pathagent/common/schemas.py`
- Test: `tests/orchestrator/test_schemas.py`, `tests/test_cache_keys.py` (extend)

- [ ] **Step 1: Add dependencies**

```bash
cd services/pathagent
uv add langgraph sse-starlette numpy pillow
uv run python -c "import langgraph, sse_starlette, numpy, PIL; print('deps ok')"
```
If `langgraph` fails to resolve, STOP and report BLOCKED (fallback: hand-rolled async loop — but
LangGraph is the locked framework, so prefer resolving it).

- [ ] **Step 2: Add agent settings** to `Settings` in `config.py`:

```python
    # ── M3 orchestrator ──────────────────────────────────────────────
    agent_enabled: bool = True
    agent_llm_url: str = "http://192.168.191.109:11500"
    agent_llm_model: str = "gemma4"          # local Ollama; "medgemma" = pathology-tuned swap
    agent_llm_timeout_s: float = 120.0
    agent_llm_max_tokens: int = 1024
    agent_max_regions: int = 8               # hard cap on navigate cycles (budget/termination)
    nav_top_k: int = 6                       # hotspot regions before coverage sampling
    kb_top_k: int = 4                        # seed-KB chunks retrieved
    phi_weights: tuple[float, float, float] = (0.34, 0.33, 0.33)  # (w_l, w_k, w_c) → φ_total
    navigation_encoder: str = "conch_v1"     # importance map lattice (design §13.3: v1 grid)
```

- [ ] **Step 3: Add heatmap cache paths.** In `cache_keys.py`, add methods to `CachePaths`
  (task-scoped, under a `heatmaps/` subdir; `_validate_segment(task_id)` guards traversal):

```python
    def heatmap(self, task_id: str) -> Path:
        _validate_segment(task_id)
        return self.root / "heatmaps" / f"{task_id}.png"

    def heatmap_meta(self, task_id: str) -> Path:
        _validate_segment(task_id)
        return self.root / "heatmaps" / f"{task_id}.json"
```

- [ ] **Step 4: Add wire schemas** to `schemas.py`:

```python
class ROI(CamelModel):
    x: int
    y: int
    width: int
    height: int

class AgentQueryRequest(CamelModel):
    item_id: str
    cache_key: str
    question: str
    task: str = "auto"                 # "auto" | "Diagnosis"
    roi: ROI | None = None

class Candidate(CamelModel):
    source: str                        # "classifier" | "llm"
    answer: str
    detail: str = ""

class Citation(CamelModel):
    text: str
    source: str

class VerifyScores(CamelModel):
    phi_l: float
    phi_k: float
    phi_c: float
    phi_total: float
```
The streamed events are plain dicts assembled by the nodes (see Task 5/6); these models are used for
request parsing and for the `final`/`verify` payload construction + tests (camel round-trip).

- [ ] **Step 5: Tests** — `test_schemas.py`: `AgentQueryRequest` parses camel (`itemId`,`cacheKey`)
  and snake; `roi` optional; `VerifyScores`/`Candidate`/`Citation` camel round-trip. Extend
  `test_cache_keys.py`: `heatmap`/`heatmap_meta` land under `root/heatmaps/`; reject unsafe `task_id`
  (`"../x"`, `"a/b"`).

- [ ] **Step 6: Run + commit**

```bash
uv run pytest tests/orchestrator/test_schemas.py tests/test_cache_keys.py -q
uv run ruff check .
git add pyproject.toml uv.lock src/pathagent/common/config.py \
        src/pathagent/common/cache_keys.py src/pathagent/common/schemas.py \
        tests/orchestrator/test_schemas.py tests/test_cache_keys.py
git commit -m "feat(pathagent): add M3 agent settings, heatmap cache paths, query schemas"
```

---

## Task 2 — Pluggable reasoning LLM client

**Files:**
- Create: `src/pathagent/orchestrator/__init__.py` (empty), `src/pathagent/orchestrator/llm_client.py`
- Test: `tests/orchestrator/test_llm_client.py`

Contract of the server (verified): `POST {url}/chat` with
`{"model":str,"system":str|None,"messages":[{"role","content"}],"max_tokens":int}` →
`{"text":str,"usage":{"input_tokens":int,"output_tokens":int}}`.

- [ ] **Step 1: Write failing tests** (respx-mocked): `complete(system, user)` posts the right body
  and returns the `text`; `complete_json(...)` parses a fenced or bare JSON object out of `text`
  (tolerates ```json fences and leading prose) and returns a dict; on HTTP error → `LLMError`; on a
  body with no parseable JSON in `complete_json` → `LLMError`; base_url trailing slash stripped.

- [ ] **Step 2: Implement**

```python
class LLMError(RuntimeError): ...

class LLMClient:
    def __init__(self, settings: Settings) -> None:
        self._url = settings.agent_llm_url.rstrip("/")
        self._model = settings.agent_llm_model
        self._timeout = settings.agent_llm_timeout_s
        self._max_tokens = settings.agent_llm_max_tokens

    def complete(self, system: str, user: str) -> str:
        body = {"model": self._model, "system": system,
                "messages": [{"role": "user", "content": user}], "max_tokens": self._max_tokens}
        try:
            resp = httpx.post(f"{self._url}/chat", json=body, timeout=self._timeout)
            resp.raise_for_status()
            return str(resp.json()["text"])
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise LLMError(f"LLM call failed: {exc}") from exc

    def complete_json(self, system: str, user: str) -> dict:
        text = self.complete(system, user)
        obj = _extract_json_object(text)      # regex/brace-match the first {...}; json.loads
        if obj is None:
            raise LLMError("no JSON object in LLM response")
        return obj
```
`_extract_json_object` must handle ```json fences and prose around the object (small LLMs wrap
output). Prefer instructing nodes to answer "JSON only", but parse defensively.

- [ ] **Step 3: Run + commit** (`git add` the two files; message
  `feat(pathagent): add pluggable reasoning LLM client`).

---

## Task 3 — Perception subprocess + runner (CONCH concept-similarity navigation, raster, KB retrieval)

**Files:**
- Create: `src/pathagent/orchestrator/perception_subprocess.py` (runs in the `pathology` env)
- Create: `src/pathagent/orchestrator/perception.py` (gateway-side wrapper)
- Create: `src/pathagent/orchestrator/seed_kb.json` (shipped; see Task 4 for content — create a
  minimal 3-entry stub here, expand in Task 4)
- Create: `src/pathagent/orchestrator/heatmap.py` (raster PNG write/read + extent meta)
- Test: `tests/orchestrator/test_perception.py`

**Subprocess I/O contract** (JSON on stdout; heavy imports only here):
- **argv/stdin:** JSON `{featuresH5, coords_from_features:true, question, concepts:[...],
  navTopK, kbSnippets:[{id,text,source}], kbTopK, rasterPng, gridStride}`.
- **stdout:** JSON `{queryEmbed:[...512], regions:[{x,y,width,height,score,rationaleKey}],
  rasterExtent:{x,y,width,height}, gridShape:[rows,cols], kbHits:[{id,text,source,score}]}`.

- [ ] **Step 1: Write `perception_subprocess.py`.** Steps inside:
  1. Load CONCH once:
     `from conch.open_clip_custom import create_model_from_pretrained, get_tokenizer, tokenize`
     `model, _ = create_model_from_pretrained("conch_ViT-B-16","hf_hub:MahmoodLab/conch", force_image_size=224)`.
  2. Read `features` (N×512) + `coords` (N×2, level-0 px top-left) + `coords.attrs`
     (`patch_size_level0`, `level0_width`, `level0_height`) from the h5.
  3. Embed `[question] + concepts` with `encode_text`; L2-normalize; L2-normalize patch features.
     **Importance per patch** = max cosine over the concept set conditioned on the question
     (`sim = feats @ txt.T`; take a question-weighted combination — v1: `0.5*sim_question +
     0.5*max(sim_concepts)`), producing `score[N]`.
  4. **Regions:** top-`navTopK` patches by score (exploitation) + a coverage sample (farthest-point
     or grid-bucket over `coords` to spread across tissue). Each region = the patch's level-0 rect
     `{x:coord_x, y:coord_y, width:patch_size_level0, height:patch_size_level0, score}`. Optionally
     merge a region to a small window (e.g. 2×2 patches) so crops carry context.
  5. **Raster:** rasterize `score` onto the patch lattice (`gridShape` from unique coords / stride),
     transparent where no tissue patch (design §13.3 gotcha 3: build over the full grid at Trident's
     exact origin). Save an RGBA PNG (colormap the normalized score) to `rasterPng`; report
     `rasterExtent` = level-0 bbox covering all patches.
  6. **KB:** embed `kbSnippets[].text` with `encode_text`; cosine vs `queryEmbed`; return top-`kbTopK`
     `kbHits`.
  7. Print the result JSON to stdout (only — keep torch logs on stderr).

- [ ] **Step 2: Write `heatmap.py`** — `write_meta(path, extent)`, `read_meta(path)`; the PNG is
  written by the subprocess. Keep colormap here if shared, else inline in subprocess. Small module.

- [ ] **Step 3: Write `perception.py` (gateway).** `NavResult` dataclass +
  `PerceptionRunner(settings)` with `run(cache_key, question, roi) -> NavResult`:
  - Resolve `cache_paths(cache_key)`; require `features(navigation_encoder)` and `coords` (raise
    `PerceptionError` if missing).
  - Load `seed_kb.json`; build the subprocess input (concepts = a fixed diagnostic prompt panel, see
    Task 4; `rasterPng = paths.heatmap(task_id)`; ensure `heatmaps/` dir exists).
  - Launch `settings.trident_python -m pathagent.orchestrator.perception_subprocess` (or pass the
    script path) with `cwd`/`PYTHONPATH` so the `pathology` env imports the module; mirror
    `trident_runner` env handling + `subprocess_timeout_s`; capture stdout; `json.loads`.
  - Validate + return `NavResult(regions, raster_extent, grid_shape, kb_hits, query_embed)`.
  - Write `heatmap_meta(task_id)` with the extent so the endpoint can set OSD headers.
  - Wrap subprocess failure / bad JSON / missing files as `PerceptionError`.

- [ ] **Step 4: Tests.** Unit test with a **synthetic tiny h5** (e.g. 12 patches × 512 random feats +
  coords with attrs) written to a tmp cache dir, monkeypatching the subprocess to a fake that returns
  a canned JSON (so no torch in CI): assert `PerceptionRunner.run` parses regions (level-0 rects),
  raster meta is written, kb_hits pass through, missing-features → `PerceptionError`. A separate
  **real** check lives in the M3 script (Task 8), not in the unit suite.

- [ ] **Step 5: Run + commit** (`git add` the four files + test; message
  `feat(pathagent): add CONCH concept-similarity perception subprocess + runner`).

---

## Task 4 — Seed KB + fact-branch retrieval

**Files:**
- Modify: `src/pathagent/orchestrator/seed_kb.json` (expand to the curated set)
- Create: `src/pathagent/orchestrator/kb.py`
- Create: `src/pathagent/orchestrator/concepts.py` (the diagnostic prompt panel for navigation)
- Test: `tests/orchestrator/test_kb.py`

- [ ] **Step 1: Author `seed_kb.json`** — 10–15 short (1–2 sentence) breast-pathology snippets, each
  `{id, text, source}`, covering IDC, ILC (E-cadherin loss, single-file growth), DCIS, benign,
  grading. Sources labelled honestly as seed (e.g. `"WHO Breast Tumours, 5th ed. (seed excerpt)"`,
  `"PathologyOutlines — Invasive lobular carcinoma (seed)"`). This is an extensible seed, **not** the
  full corpus (documented in the report).

- [ ] **Step 2: Author `concepts.py`** — `DIAGNOSTIC_CONCEPTS: list[str]` = short CONCH-style
  captions for the navigation panel (e.g. `"invasive ductal carcinoma"`,
  `"invasive lobular carcinoma, single-file pattern"`, `"tumor cells infiltrating stroma"`,
  `"benign breast tissue"`, `"high nuclear grade"`). Used by the perception subprocess as the concept
  set; the question is embedded alongside.

- [ ] **Step 3: Write `kb.py`** — `load_seed_kb() -> list[dict]`; `to_citations(kb_hits) ->
  list[Citation]` (map subprocess hits → `Citation(text, source)`); a `fact_score(llm, candidate,
  kb_hits) -> tuple[float, list[Citation]]` that asks the LLM to score factual alignment (0..1) of the
  candidate answer against the retrieved snippets and returns the score + the snippets as citations.
  On `LLMError`, degrade to a neutral score (e.g. 0.5) and still return the citations (abstention).

- [ ] **Step 4: Tests** — `load_seed_kb` returns the shipped entries with required keys;
  `to_citations` maps correctly; `fact_score` with a fake LLM (returns `{"phiK":0.8}`) yields 0.8 +
  citations; fake LLM raising `LLMError` → neutral 0.5 + citations (no exception).

- [ ] **Step 5: Run + commit** (`git add` the four files; message
  `feat(pathagent): add seed KB, diagnostic concepts, and fact-branch scoring`).

---

## Task 5 — AgentState + reasoning nodes (router/triage/navigate/describe/diagnose)

**Files:**
- Create: `src/pathagent/orchestrator/state.py`, `src/pathagent/orchestrator/nodes.py`
- Test: `tests/orchestrator/test_nodes.py`

- [ ] **Step 1: `state.py`** — `AgentState` TypedDict (design §13.2):
  `question, task, item_id, cache_key, roi, task_id, nav: NavResult|None, visited: list[dict],
  candidates: list[dict], scores: dict, citations: list[dict], prelim: str, final: dict,
  budget: dict{max_regions, spent}, events: list[dict]`. Provide `emit(state, event: dict)` that
  appends to `state["events"]` (the graph drains these to the SSE stream; keeps nodes pure and
  testable without a live stream writer). Include small builders for each event dict.

- [ ] **Step 2: `nodes.py`** — each node takes `(state, deps)` where `deps` bundles
  `LLMClient`, `PerceptionRunner`, `Settings`, and the loaded `classifier.json` dict (or None):
  - `router`: LLM (or trivial rule for `task="Diagnosis"`) → sets `task="Diagnosis"`, tools list;
    emits `route`. `task="auto"` with a breast question → Diagnosis.
  - `triage`: read `classifier.json` (if present) + a short LLM read → `risk` (benign/suspicious),
    `depth`, and `budget.max_regions` (benign≈3 / suspicious≈`agent_max_regions`, hard cap 12);
    emits `triage`.
  - `navigate`: on first entry, call `PerceptionRunner.run(...)` once → `state["nav"]`; then pop the
    next unvisited region within budget, append to `visited`, emit `navigate` with
    `{region, zoom, rationale}` (zoom derived from region size; rationale from the concept/score).
  - `describe`: LLM describes the current region from its coords + score + concept context (no pixel
    fetch in v1 — Girder crop fetch is an M4/live-ROI concern; note this honestly). Append findings to
    `visited[-1]`, emit `describe`.
  - `diagnose`: build candidates — (a) `classifier` candidate from `classifier.json`
    (IDC/ILC + confidence), (b) `llm` candidate synthesizing the visited findings; set `prelim`;
    emit `diagnose` with both candidates.

- [ ] **Step 3: Tests** (fake LLM returning canned JSON, fake PerceptionRunner returning a canned
  `NavResult`, a canned classifier dict): each node emits its event with the right shape; `navigate`
  respects budget (won't exceed `max_regions`); `diagnose` includes the classifier candidate when
  `classifier.json` present and only the LLM candidate when absent; nodes degrade on `LLMError`
  (emit an event, don't raise).

- [ ] **Step 4: Run + commit** (`git add` the three files; message
  `feat(pathagent): add agent state + reasoning nodes`).

---

## Task 6 — Verification branches + summary (φ_l, φ_k, φ_c, φ_total)

**Files:**
- Create: `src/pathagent/orchestrator/verify.py`
- Test: `tests/orchestrator/test_verify.py`

- [ ] **Step 1: Implement branches** (each takes `(state, deps)`, returns a partial-scores dict;
  designed to run in parallel graph branches):
  - `icv` (φ_l): LLM logic judge — given the chosen candidate + visited findings, score internal
    consistency / evidence validity 0..1. Degrade to 0.5 on `LLMError`.
  - `fact` (φ_k): `kb.fact_score(llm, candidate, state["nav"].kb_hits)` → φ_k + citations (Task 4).
  - `consensus` (φ_c): compare the diagnosed subtype string vs the classifier candidate — agreement →
    high (e.g. classifier confidence scaled to 0..1), disagreement → low and **surface the conflict**
    as a note (design §11: disagreement lowers φ_c/confidence). If no classifier → neutral 0.5 + a
    "no consensus source" note.
  - `summary`: `phi_total = w_l*phi_l + w_k*phi_k + w_c*phi_c` (weights from `settings.phi_weights`,
    renormalized over available branches); pick the higher-support candidate; LLM (or template)
    synthesizes `final.answer`; `confidence = round(100*phi_total)`; attach `heatmapTaskId=task_id`,
    `trail = [r region rects from visited]`, citations, and any conflict notes. Emit `verify` (scores +
    citations) then `final`.

- [ ] **Step 2: Tests** — φ_total math (weights renormalized when a branch is missing); consensus
  agreement vs conflict (conflict lowers φ_c and adds a note); summary picks the right candidate;
  `final` carries `heatmapTaskId` + non-empty `trail`; missing-classifier path yields neutral φ_c +
  note; LLM failures degrade, never raise.

- [ ] **Step 3: Run + commit** (`git add` the two files; message
  `feat(pathagent): add dual verification branches + summary`).

---

## Task 7 — LangGraph wiring + SSE `/query` endpoint + heatmap endpoint

**Files:**
- Create: `src/pathagent/orchestrator/graph.py`
- Modify: `src/pathagent/gateway/routes.py`
- Test: `tests/orchestrator/test_graph.py`, `tests/test_routes_query.py`

- [ ] **Step 1: `graph.py`** — `build_graph()` wires the StateGraph:
  `router → triage → navigate → describe → (conditional: budget left & not converged → navigate else
  diagnose) → diagnose → icv,fact,consensus (parallel) → summary → END`. Provide
  `async def run_query(request: AgentQueryRequest, deps) -> AsyncIterator[dict]` that invokes the
  graph and **yields each event dict** as nodes emit them. Simplest robust approach for v1: run nodes
  and, after each node, drain `state["events"]` to the async generator (LangGraph `astream` with a
  custom writer is fine too — pick one, keep it deterministic). Mint `task_id` (uuid) at entry; load
  `classifier.json` once into `deps`.

- [ ] **Step 2: `POST /api/agent/query`** in `routes.py` — `require_user`; parse
  `AgentQueryRequest`; return `EventSourceResponse` (sse-starlette) over `run_query(...)`, serializing
  each event dict as JSON. On any unhandled orchestrator error, emit a terminal
  `{type:"error",message}` event (never a bare 500 mid-stream). Guard `cacheKey`/`itemId` with the
  existing `_validate_segment` semantics (400 on unsafe before streaming).

- [ ] **Step 3: `GET /api/agent/cases/{itemId}/heatmap/{taskId}`** — `require_user`; resolve
  `cache_paths(cacheKey)` (cacheKey query param, like the other GETs); 404 if `heatmap(taskId)`
  missing; return `FileResponse(png, media_type="image/png")` with `X-Level0-X/Y/Width/Height` headers
  from `heatmap_meta`. 400 on unsafe ids.

- [ ] **Step 4: Tests** — `test_graph.py`: `run_query` with fake deps yields the event sequence
  `route,triage,navigate*,describe*,diagnose,verify,final` in order; budget cap honored; a perception
  failure yields a graceful `final` with abstention (or an `error` event) — not an exception.
  `test_routes_query.py` (FastAPI `TestClient`, deps overridden with fakes + `require_user` bypass):
  `/query` streams SSE `data:` lines that parse to the event objects and end with `final`; heatmap
  endpoint returns the PNG bytes + extent headers when present, 404 when absent, 400 on unsafe id.

- [ ] **Step 5: Run full suite + commit**

```bash
uv run pytest -q
uv run ruff check .
git add src/pathagent/orchestrator/graph.py src/pathagent/gateway/routes.py \
        tests/orchestrator/test_graph.py tests/test_routes_query.py
git commit -m "feat(pathagent): wire LangGraph loop + SSE query and heatmap endpoints"
```

---

## Task 8 — Real-WSI end-to-end verification + report

**Files:**
- Create: `scripts/m3_real_slide.py`
- Create: `docs/Chen/2026-07-07-pathagent-m3-report.md`

- [ ] **Step 1: `scripts/m3_real_slide.py`** — mirrors `m2_real_slide.py`:
  1. `--slides-root/--slide-id` (default BRACS_1648) or `--girder-item`; `--cache-dir` (required,
     world-traversable — §7 of the M2 report: the classifier subprocess + Girder must read it).
  2. Run the **real worker** (`run_trident_preprocess`) with `backbone=conch_v1 + consensus=uni_v1` to
     (re)generate the cache incl. `classifier.json` (reuse the M2 flow), asserting `ready`.
  3. Build an `AgentQueryRequest(itemId, cacheKey, question="What is the invasive carcinoma subtype
     and why?", task="Diagnosis")`.
  4. Drive `run_query(...)` with **real deps** (real `LLMClient` → :11500, real `PerceptionRunner` →
     CONCH subprocess over the real cached features, real `classifier.json`), collecting events.
  5. **Assertions (the real-WSI test):**
     - stream contains `route, triage, ≥1 navigate, ≥1 describe, diagnose, verify, final`.
     - every `navigate.region` is within level-0 `manifest.level0_width × level0_height`.
     - `diagnose.candidates` includes a `classifier` candidate whose answer ∈ {IDC, ILC} and matches
       `classifier.json.prediction`.
     - `verify.scores` has real φ_c derived from the classifier; `0 ≤ phiTotal ≤ 1`.
     - `final.answer` non-empty; `final.confidence` in 0..100; `final.trail` non-empty;
       `final.heatmapTaskId` set and `cache_paths(cacheKey).heatmap(taskId)` is a real PNG whose
       `heatmap_meta` extent is within level-0 bounds.
     - print a `[PASS]/[FAIL]` report like the M2 script; exit non-zero on any failure.

- [ ] **Step 2: Run it for real**

```bash
export HF_TOKEN=<hf_...>
cd services/pathagent
mkdir -p /tmp/pathagent-m3-cache && chmod 755 /tmp/pathagent-m3-cache
uv run python scripts/m3_real_slide.py \
    --slides-root /home/chen/data2/BRCA-TEST --slide-id BRACS_1648.svs \
    --cache-dir /tmp/pathagent-m3-cache
```
Expected: all checks PASS; a real Diagnosis stream (ILC, matching M2), a real heatmap PNG, a real
navigation trail.

- [ ] **Step 3: Write `2026-07-07-pathagent-m3-report.md`** — exec summary; scope & honest boundaries
  (seed KB vs full KB; local LLM vs GPT-4V; SlideChat deferred; M4 replay deferred); what was built
  (table); verification (unit count + real-WSI evidence); review process + fixes; how-to-run;
  follow-ups (Girder crop fetch for `describe`; full KB; SlideChat candidate; item-level authz carried
  from M1/M2; durable checkpointer for redirect-resume); commit log; recommendation.

- [ ] **Step 4: Commit** (`git add scripts/m3_real_slide.py docs/Chen/2026-07-07-pathagent-m3-report.md`;
  message `test(pathagent): add M3 real-WSI verification + report`).

---

## Self-review (author)
- **Spec coverage:** router/triage/navigate/describe/diagnose/verify(icv|fact|consensus)/summary →
  Tasks 5–6; all 7 stream events + heatmap tile → Task 7; navigation trail + zoomable heatmap + cited
  verified answer (the M3 "Done when") → Tasks 3/4/6/7; level-0 geometry (§13.1) → subprocess + wire
  schemas; LangGraph (§13.2) → Task 7; pluggable reasoning LLM (§2/§11) → Task 2. Covered.
- **Honest deferrals** are explicit and non-faked: SlideChat, GPT-4V, full KB, M4 replay, M3b tasks.
- **Type consistency:** `NavResult`, `AgentQueryRequest`, `VerifyScores`, event dicts, `CachePaths.
  heatmap/heatmap_meta`, `phi_l/phi_k/phi_c/phi_total` used consistently across tasks.
- **Isolation:** torch/CONCH only in `perception_subprocess.py` (pathology env); gateway venv gains
  only langgraph/sse-starlette/numpy/pillow.
```
