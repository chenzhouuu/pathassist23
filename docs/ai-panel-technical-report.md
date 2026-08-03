# AI Panel — Technical Report

**Status:** removed 2026-08-03. This document is what remains.
**Scope:** the **AI** tab in the right panel, the four `Analyze …` entries in the slide context
menu, and the three API modules behind them.
**Companion:** `docs/askpa-technical-report.md` (the chat tab, removed the same day).

---

## 1. What it was

A right-panel tab that displayed the results of **Ki67 immunohistochemistry scoring** and two
**tumour-composition grids**, all computed by vision models called **directly from the browser**.

The panel itself never started anything. Every run began in the slide's right-click menu:

| Menu entry | Model | What it did |
|---|---|---|
| `Analyze Ki67 % · Pragna` | Claude Sonnet 4.6 | Count brown (DAB, Ki67+) vs blue (haematoxylin, Ki67−) nuclei in one drawn box |
| `Analyze Ki67 % · Pragna(Zi)` | Gemini 2.5 Flash Lite | Same task, cheaper model |
| `Analyze Region Tumar` | Gemini 2.5 Flash Lite | Split a drawn box into 3×3, estimate tumour/stroma/necrosis per cell, aggregate |
| `Analyze WSI Tumar` | Gemini 2.5 Flash Lite | Split the whole slide into 4×4, same per-patch estimate, aggregate |

Both vendors were presented to the user under one brand name, **Pragna** — `AI_MODEL_LABEL` and
`GEMINI_MODEL_LABEL` were both the string `'Pragna'`, and the result card's `ModelTag` hard-coded it.
After this removal the name appears nowhere in `src/`.

### Data flow

```
right-click → "Analyze …"          ContextMenu.jsx
        │
        ▼  setDrawingMode('roi-select')
user drags a box on the slide      AnnotationCanvas.jsx  →  store.roiSelectResult
        │
        ▼  a useEffect notices (pending flag + roiSelectResult)
GET /api/v1/item/{id}/tiles/region     api/index.js  getRegionImageBlob()
        │  PNG blob for those base pixels
        ▼
browser → Anthropic SDK / Google Generative AI SDK      claudeApi.js · geminiApi.js · wsiAnalysis.js
        │  base64 image + a JSON-only prompt
        ▼
JSON parsed, key names normalised, dashed `ai-roi` annotation written back to Girder
        │
        ▼
store.addAiResult()  →  localStorage['pathassist_ki67_results']  (newest first, capped at 20)
        │
        ▼
AI tab renders ResultCard / WsiResultCard / ErrorCard
```

No image data passed through Girder on the way out — the browser held the API key and talked to the
vendor itself.

### What Ki67 returned

```json
{
  "ki67_percentage": 42.5,
  "positive_count": 212,
  "negative_count": 288,
  "total_count": 500,
  "stain_quality": "good",
  "proliferation_activity": "high",
  "interpretation": "High Ki67 proliferation index consistent with aggressive neoplasm.",
  "confidence": "high",
  "notes": ""
}
```

`proliferation_activity` was bucketed `low` (<15%), `intermediate` (15–30%), `high` (>30%);
`stain_quality` ∈ {good, fair, poor}; `confidence` ∈ {high, medium, low}. `normalizeResult()` in
`claudeApi.js` accepted about twenty alternative key spellings (`ki67Index`, `positiveCells`,
`brownNuclei`, …) because the models did not reliably emit the requested schema — worth remembering
if this is ever rebuilt: **prompt-level "return exactly this JSON" was not sufficient**, and the fix
used here was a normalisation layer rather than a structured-output constraint.

### What the grids returned

Per patch: `tumor_pct`, `stroma_pct`, `necrosis_pct`, `other_pct` (asked to sum to 100),
`tissue_type`, `confidence`, `notes`. A patch whose non-background pixel fraction fell below 0.15 was
skipped without a model call — a cheap local heuristic (`tissueFraction()`, 64×64 downsample, white
and black thresholds) that is worth keeping in any rebuild.

Aggregated across patches: mean/std/min/max tumour %, a 5-bin histogram, `tumor_purity`
(= tumour / (tumour + stroma)), mean necrosis, mean stroma, and a `heterogeneity_index`
(= std/mean of tumour %). The whole-slide run refused to report with fewer than 3 analysable
patches; the ROI grid, fewer than 2.

---

## 2. Deployment status at removal

**Non-functional on every box we control.** `.env.local` contained neither
`VITE_ANTHROPIC_API_KEY` nor `VITE_GEMINI_API_KEY`, and all four entry points begin with

```js
if (!apiKey) throw new Error('VITE_…_API_KEY is not set. Add it to .env.local and restart the dev server.');
```

so every menu entry produced an error card immediately. This matches what was found for AskPA the
same day: two model-facing features, neither reachable, both removed.

---

## 3. Known defects — all present at removal

These are recorded because they explain the decision, and because a rebuild that reproduces the
architecture would reproduce most of them.

### Blocking

**D1 · Both "Locate ROI" buttons used the wrong coordinate space.**
`AIPanel.jsx:11` and `WsiResultCard.jsx:123` built an `OpenSeadragon.Rect` from **image pixels** and
passed it straight to `viewport.fitBounds()`, which takes **viewport** coordinates (roughly 0–1
across the slide). Neither button jumped to the region it named. The correct form was already in the
same repo twice — `useRegionSelect.js:52` and `agentViewerSync.js:10` both call
`imageToViewportRectangle()` first. Each site was one missing line.

**D2 · The single-ROI Ki67 fetch had no size cap.**
`AnnotationCanvas.jsx:228` called `getRegionImageBlob(itemId, x, y, w, h, 40)` and omitted
`maxOutputPx`, so Girder returned the region at full 40× resolution. A 5000×5000 box is a 25-megapixel
PNG; base64-encoded it exceeds the vendor's per-image request limit and the call fails. This is the
mirror image of the defect that removed the Panels tab a day earlier (`1c6844a`), where every region
was squashed to 512 px regardless of size. The grid path, notably, got this right — it passed
`PATCH_OUTPUT`.

### Correctness

**D3 · Results were not scoped to a slide.**
`aiResults` was one global `localStorage` queue capped at 20, and `setActiveItem` did not clear it.
Open a second slide and the first slide's cards were still listed. Combined with D1, clicking
"Locate ROI" on a foreign card moved the current slide's viewport to a position computed in the wrong
units from another slide's coordinates.

**D4 · `ROI_PATCH_MAG` was dead.**
`wsiAnalysis.js:267` declared `const ROI_PATCH_MAG = 20; // higher magnification for ROI (more detail)`
and nothing read it — `runPatchLoop` used the module-level `PATCH_MAG = 10`. The ROI grid ran at the
same magnification as the whole-slide grid, and had done since it was written.

**D5 · The Gemini price constants named a different model.**
`GEMINI_MODEL` was `gemini-2.5-flash-lite`, but the rates were `$1.25 / $5.00` per MTok under a
comment reading `Gemini 1.5 Pro (≤128K context)`. Flash Lite is roughly an order of magnitude
cheaper, so every cost figure shown for a Gemini run was substantially overstated. The Claude side
(`$3 / $15` for `claude-sonnet-4-6`) was correct.

**D6 · The grid prompt asserted a fixed physical scale that was often false.**
`wsiAnalysis.js:22` told the model each patch was "512×512 pixels, 10× magnification, ~0.5mm ×
0.5mm". Patch dimensions were actually `Math.min(cellW, …)`, so on a small slide or a small ROI the
model was estimating area fractions against a stated scale that did not match the image it was
given.

**D7 · Slide-level conclusions rested on 16 samples.**
The whole-slide grid analysed 16 patches at fixed cell centres — on the order of 4 mm² of tissue —
and `WsiResultCard` presented `tumor_purity` and `heterogeneity_index` to three decimal places. Fixed
centres also meant a slide with off-centre tissue could fail outright with `Insufficient tissue`
while plenty of tissue sat between the sample points.

### Naming and dead code

- **D8** — one model, three names: `claudeApi.js:2` said "Claude 3.5 Sonnet", the function was
  `analyzeKi67WithOpus()`, and `AI_MODEL` was `claude-sonnet-4-6`. `AIPanel.jsx:2` also said "Claude
  Opus". Sonnet 4.6 is what ran.
- **D9** — `ModelTag({ label })` accepted a label and rendered the hard-coded string `Pragna`;
  `AnalyzingCard` read `ki67PendingModel` into a variable it never used. A consequence of the
  single-brand decision, but implemented as dead parameters rather than by dropping them.
- **D10** — `geminiApi.js:3` documented `VITE_GOOGLE_AI_API_KEY`; the code read `VITE_GEMINI_API_KEY`.
- **D11** — `id: Date.now().toString()` collides for two results in the same millisecond.

---

## 4. Why it was removed rather than repaired

Three reasons, in order of weight.

1. **The key could not be protected.** A browser-side vendor call needs the key in the browser, and
   Vite inlines `VITE_*` into the bundle. Anyone who could load the page could read it. There is no
   configuration that fixes this while the call stays in the browser.

2. **The results could not be shared or trusted to persist.** They lived in one browser's
   `localStorage`, capped at 20, not keyed by slide. A colleague opening the same slide saw nothing.
   Meanwhile every other analysis in the app had already moved to Girder jobs with artifacts that the
   Workspace lists, the Runs list tracks, and a second reader can open.

3. **The numbers had defects that reached the user.** D2 made large regions fail, D5 misreported
   cost, D3 and D1 together sent the viewer to the wrong place, and D7 dressed 16 samples as a
   slide-level measurement. Repairing all of these would have produced a correct version of an
   architecture we had already decided against.

Nothing here is an argument that VLM Ki67 scoring is a bad idea — only that this delivery of it was
the wrong shape.

---

## 5. What was removed

**Deleted files**

```
src/api/claudeApi.js                             150 lines
src/api/geminiApi.js                             105
src/api/wsiAnalysis.js                           302
src/components/panels/AIPanel.jsx                351
src/components/panels/WsiResultCard.jsx          ~330
src/components/panels/WsiAnalyzingCard.jsx       ~90
```

**Edited**

| File | Change |
|---|---|
| `RightPanel.jsx` · `ViewerApp.jsx` | the `ai` tab, from the bar and the collapsed rail — 5 tabs → 4 |
| `ContextMenu.jsx` | the four `Analyze …` entries and their three props |
| `AnnotationCanvas.jsx` | both analysis effects, `handleAnalyzeKi67/Wsi/RoiGrid`, `saveAiRoiAnnotation`, `updateAiRoiAnnotation` — 268 lines |
| `store/index.js` | `aiResults` + its three actions, `ki67PendingModel`, `ki67RoiPending`, `ki67Analyzing`, `roiWsiPending`, `wsiAnalyzing`, `wsiProgress` |
| `package.json` | `@anthropic-ai/sdk`, `@google/generative-ai` (4 packages) |
| `deploy/.env.example` · `CHANGELOG.md` | key references and §1 |

**Deliberately kept**

- **`roi-select` / `roiSelectResult` / `shownRoi`** — the draw-a-box handshake. It is the AI tab's
  only genuinely reusable piece and both `AnalysisPanel` and `CopilotPanel` depend on it.
- **`ai-roi` rendering** — `annotationUtils.js:236` (dashed outline, lighter fill) and
  `LayersPanel.jsx:13`. Annotations already written to Girder under that group stay on their slides
  and still draw correctly. Nothing creates new ones.
- **`getRegionImageBlob()`** in `api/index.js` — now without a caller, kept as a Girder endpoint
  binding like everything else in that module, with a comment recording the missing size cap (D2).
- **The camera → Girder `Captures` upload** in `ViewerToolbar.jsx` — unrelated, untouched, and
  documented in CHANGELOG §2.

**Inert leftovers.** `localStorage['pathassist_ki67_results']` may still sit in a returning user's
browser; nothing reads it. `.env.local` files in the wild may still carry the two API keys and the
two DCPenn URLs; nothing reads those either, and they should be deleted (and the keys rotated if
they were ever served).

---

## 6. If this is rebuilt

Do it as an entry in the **Analysis** catalog, not as a panel.

- **Where the model call goes:** a service behind the gateway, holding its own credential, the way
  `services/pathvlm` and the biomarker/tissue/nuclei services already do. The browser submits
  parameters, not pixels.
- **Where the run lives:** a Girder job. The Runs list already spans slides and users, stop/resume
  already works, and failure already surfaces as a job log rather than a card that vanishes on
  refresh.
- **Where the numbers live:** an artifact keyed to the slide, so the Workspace can open it and a
  second reader can see it.
- **Region handling:** reuse `useRegionSelect`; cap the fetched region explicitly (D2); state the
  patch's real µm extent in the prompt rather than a constant (D6).
- **Reporting:** if a slide-level number comes from N patches, show N next to it and do not print
  more precision than N supports (D7).
- **Schema:** prefer a structured-output constraint over a normalisation layer that guesses at twenty
  key spellings.

The strongest candidate to carry over unchanged is `tissueFraction()` — a local background test that
avoided a model call on empty patches, and cost nothing.

---

*Removed on branch `feature/copilot-agent`. The code is one `git show` away; this document exists so
that reaching for it is a decision rather than an excavation.*
