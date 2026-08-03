# AskPA — Technical Report

**Status:** removed from the codebase on 2026-08-03. This document is the whole record.

AskPA was a multi-turn, vision-capable chat panel for pathology case consultation — the fifth tab
in the right panel, gated on the `ai-users` role. A pathologist could ask about the slide on screen,
attach a snapshot of the current viewport, run a BRCA subtype classifier, and turn the resulting
conversation into a structured pathology report.

It is documented here rather than in the code because the feature never ran end-to-end in this
deployment: at removal, all four of its models were unreachable (see *Deployment status* below).

---

## Architecture

```
PathChatPanel.jsx  (UI: thread, model pills, attach, BRCA, report modal)
        │
        ├── store/index.js   chatMessages · chatLoading · chatError
        │                    chatModel (localStorage) · chatPendingAttachment
        │                    — thread NOT persisted; cleared on slide change
        │
        └── api/pathChatApi.js
                ├── sendPathChat()  ──┬── Anthropic SDK   (Sonnet, Opus)
                │                     ├── Google AI SDK   (MedGemma)
                │                     └── fetch → DCPenn  (Gemma 4, local Ollama)
                ├── generateReport()  — replays the thread + a 5-section request
                ├── predictBRCA()     — fetch → DCPenn BRCA service
                ├── captureViewport() — OSD canvas → ≤800px JPEG q0.82 → base64
                ├── buildSystemPrompt()  — slide name, dimensions, native mag
                └── buildContextSuffix() — "[Zoom: 12.3× | Active ROI: (x,y) w×h px]"
```

Every model call went **directly from the browser**. No request passed through Girder or the agent
gateway, which is why the API keys had to be `VITE_*` variables baked into the bundle.

---

## Features

| # | Feature | Notes |
|---|---|---|
| 1 | Multi-turn vision chat | Enter to send, Shift+Enter newline; typing indicator; auto-scroll; failures render as a red assistant bubble |
| 2 | Four-model selector | Pills; choice persisted in `localStorage.pathassist_chat_model`; catalog filterable via `VITE_ENABLED_CHAT_MODELS` |
| 3 | Per-message usage footer | Model label · input/output tokens · USD cost |
| 4 | Slide-context injection | System prompt built from `activeItem` + `tilesInfo`; every user message carried a live zoom/ROI suffix, stripped from the displayed bubble |
| 5 | Viewport attachment | 📷 captures the OpenSeadragon canvas; preview strip with remove; renders as an 80×56 thumbnail in the user bubble |
| 6 | BRCA subtype prediction | IDC vs ILC, rendered as an ASCII bar chart with confidence, patch count, top-attention patches, and ground truth when indexed |
| 7 | Report generation | Replays the thread asking for CLINICAL HISTORY / GROSS DESCRIPTION / MICROSCOPIC DESCRIPTION / DIAGNOSIS / COMMENT; modal with Copy and Download `.txt` |
| 8 | Empty-state suggestions | Five starter chips; clicking fills the input without sending |

The conversation was **per-slide and ephemeral**: opening another slide cleared both the thread and
any pending attachment, with no warning and no history to return to.

### System prompt

The prompt named the assistant, stated the slide's name, dimensions, and native magnification, and
carried five behavioral constraints worth preserving if the feature is ever rebuilt:

- think step by step before concluding
- use standard pathology terminology
- distinguish definitive findings from differential possibilities
- say so explicitly when image quality or field of view is insufficient — do not guess
- never fabricate counts or percentages; label estimates as estimates

---

## Models

| Label | Model ID | Provider | Cost (per MTok) |
|---|---|---|---|
| Sonnet | `claude-sonnet-4-6` | Anthropic, browser SDK | $3 in / $15 out |
| Opus | `claude-opus-4-6` | Anthropic, browser SDK | $5 in / $25 out |
| MedGemma | `medgemma-4b-it` | Google AI Studio | free |
| ⚡ Gemma 4 | `gemma4` | DCPenn, local Ollama via FastAPI | free — no data left the server |

**The cost figures the panel displayed for Opus were wrong.** `pathChatApi.js` hard-coded
`$15 in / $75 out` for `claude-opus-4-6`, against a real price of `$5 / $25` — so every Opus usage
footer overstated spend by roughly 3×. The Sonnet row was correct. Both model IDs were valid and
active at removal.

### BRCA classifier

An ABMIL 5-fold ensemble (reported AUC 0.9624) over a 942-slide TCGA BRCA index of pre-extracted
UNI features, served from DCPenn as a FastAPI microservice. It accepted a slide name, returned IDC
vs ILC probabilities plus the top-attention patches, and had two dedicated error states — slide not
in the index, and slide not breast tissue (which suggested attaching a snapshot and asking directly
instead).

AskPA was its **only** frontend entry point. Removing AskPA left the service without a caller; the
service itself was not touched.

---

## Deployment status at removal (verified 2026-08-03)

None of the four models could have answered a request on this box:

| Model | Requires | Actual |
|---|---|---|
| Sonnet, Opus | `VITE_ANTHROPIC_API_KEY` | absent from `.env.local` |
| MedGemma | `VITE_GEMINI_API_KEY` | absent from `.env.local` |
| Gemma 4 | `192.168.191.109:11500` | unreachable |
| BRCA | `192.168.191.109:11501` | unreachable |

There was also a routing gap: `pathChatApi.js` defaulted to `/api/llm` and `/api/brca`, but
`vite.config.js` only proxies `/api/copilot` → agent gateway and `/api` → Girder. Without the
`VITE_DCPENN_*` overrides in `.env.local`, both paths would have resolved to Girder and 404'd. The
overrides existed, pointing at a host that no longer answers.

---

## Known defects

1. **Browser-side API keys.** `VITE_ANTHROPIC_API_KEY` and `VITE_GEMINI_API_KEY` were inlined into
   the production bundle by Vite; anyone who could load the page could extract them. The Anthropic
   client ran with `dangerouslyAllowBrowser: true`.
2. **Wrong Opus pricing** (above) — a number shown to the user that was not derived from the model
   actually being billed.
3. **`dangerouslySetInnerHTML` on model output.** The report modal ran a hand-rolled
   markdown→HTML conversion with no escaping and injected the result directly.
4. **Conversation lost on slide change**, silently, with no persistence and no history.
5. **No cancel.** An in-flight request could not be aborted.
6. **Duplicate markdown renderer.** The assistant bubble reimplemented inline markdown while
   `panels/markdown.jsx` — with tests — already existed.

---

## What was removed

```
src/components/panels/PathChatPanel.jsx     deleted (593 lines)
src/api/pathChatApi.js                      deleted (269 lines)
src/store/index.js                          chat state + actions; the slide-change reset
src/components/panels/RightPanel.jsx        import, tab entry, render branch
src/components/ViewerApp.jsx                rail tab entry
src/components/panels/RightPanel.test.jsx   'AskPA' dropped from EXPECTED_TABS (6 tabs → 5)
deploy/.env.example                         AskPA-specific variables
docs/                                       AskPA references in current-implementation docs
```

Nothing shared left with it. `@anthropic-ai/sdk` and `@google/generative-ai` keep other consumers
(`claudeApi.js`, `geminiApi.js`, `wsiAnalysis.js`), so both dependencies stay.

Dated design records under `docs/Chen/plans/` and `.scratch/` still mention AskPA. They are records
of what was decided at the time, not descriptions of the current system, and were deliberately left
unedited.

---

## If it is rebuilt

Three things should change:

- **Move the model calls server-side.** Every other analysis in this codebase runs as a Girder job;
  AskPA was the last browser-direct path, and it is what forced the key exposure.
- **Persist the thread.** Per-slide and per-user, the way the Copilot thread already is — a
  consultation that vanishes when you look at another slide is not a consultation.
- **Derive displayed numbers from the call that produced them.** Cost, token counts, and any
  quantitative claim should come from the response, not from a constant maintained by hand.

The Copilot panel (`CopilotPanel.jsx`) already satisfies the first two and is the natural place for
this capability to land rather than a second chat surface.
