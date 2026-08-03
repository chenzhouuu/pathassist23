# PathAssist / Impart DX — Project Overview & Competitive Landscape

**Prepared:** 2026-06-29
**Author:** Chen
**Scope:** Whole-project review + competitor analysis (industry & academia)

---

## 1. Project Summary

**PathAssist** (commercialized as **Impart DX**) is a **multi-tenant, white-label digital
pathology platform** — a browser-based whole-slide image (WSI) viewer with an embedded AI
layer, aimed at clinical pathology workflows with a lymphoma/DLBCL focus and broader
oncology ambitions (breast, lung).

It is, at its core, a **productized custom build on top of the open-source Digital Slide
Archive (DSA) stack** — a proprietary React frontend plus a bundled AI suite layered over
Girder 5 / HistomicsUI.

### 1.1 Architecture

| Layer | Technology |
|---|---|
| **Frontend** | React 18 + Vite + Zustand + TanStack Query + Tailwind; OpenSeadragon 4.x WSI viewer; canvas annotation overlay |
| **Backend** | Girder 5 / DSA v5 (Python + MongoDB), `large_image` tile server, Slicer CLI Web for Dockerized analysis jobs |
| **Auth** | Keycloak 24 SSO (OIDC/OAuth2); custom `keycloak_oauth_provider.py` syncing Keycloak groups → Girder ACL groups |
| **Infra** | AWS EC2 + nginx reverse proxy + Docker Compose; GCE/AWS spot deploy variants; on-prem GPU node (DCPenn, RTX A6000) |
| **AI inference** | `PathAssistModel` — FastAPI + Celery + Redis running TIAToolbox **HoVer-Net** nuclei segmentation → Girder annotations; AWS GPU-spot bootstrap |

**Multi-brand white-label:** one backend, multiple Vite builds driven by `VITE_*` env vars —
**Impart DX**, **AlgoPath**, **MDA** all run off `src/config/branding.js`.

**Multi-tenant model:** 1 Girder Collection = 1 org, 1 Folder = 1 patient/case, with 9 roles
(super-admin → lab-manager → pathologist → fellow → researcher → lab-tech →
second-opinion-reviewer → referring-physician → patient) and dedicated portals per role.

### 1.2 AI Suite (key differentiation)

1. **Copilot** — a conversational agent over the shared tool library, running against the
   `services/agent` gateway with per-slide threads persisted server-side. It grounds its
   answers in tool output (nuclei counts, tissue maps, marker maps) rather than in a
   screenshot, and every number it states is tool-derived.
   *(A second chat panel, **AskPA**, ran browser-direct vision LLMs against a viewport
   snapshot. It was removed on 2026-08-03 — see `docs/askpa-technical-report.md`. Claims
   below about a local, $0-egress LLM option refer to that panel and no longer hold.)*
2. ~~**"Pragna"** — Ki67 IHC quantification + whole-slide tissue composition analysis
   (tumor%, stroma%, necrosis%, purity, heterogeneity index) via a grid of patches sent to
   Claude/Gemini vision, all browser-side.~~
   *Removed on 2026-08-03, the same day as AskPA and for the same reason: the API key had to
   ship in the bundle and the results lived in one browser's localStorage. The platform has no
   browser-side model call left — every analysis is submitted from the Analysis catalog and runs
   as a Girder job. See `docs/ai-panel-technical-report.md`.*
3. **Slide-level classifiers (MIL)** — the research group's models: BRCA IDC-vs-ILC
   (AUC 0.947), NSCLC subtyping (AUC 0.976), DLBCL (AUC 0.681), using **LCR-MIL**
   (student–teacher distillation reviewing ~6.5% of patches) and **HG-MIL**, on
   UNI / H-optimus-0 foundation-model features. Deployed as FastAPI microservices on DCPenn.
   **The BRCA classifier currently has no frontend entry point** — AskPA was its only caller.
4. **Nuclei segmentation** — HoVer-Net (TIAToolbox) + Cellpose/CellViT via Slicer CLI Docker modules.

### 1.3 Context

Built by Trilok Kantheti (platform architect) in collaboration with Chen's computational
pathology research group. The platform is the productization vehicle for the group's
LCR-MIL / HG-MIL / agentic-pathology research (Paper 3 targets *"Adaptive Agentic Inference
for WSIs: when to think, where to look, and when to stop"*).

---

## 2. Competitive Landscape

The product spans **three layers**, each with distinct competitors:
(A) image-management / viewer **platform**, (B) AI-diagnostic **application**, and
(C) AI **copilot / agent**. The copilot layer is the most novel — and most contested.

### 2.A Industry — Full-stack AI diagnostic & platform companies

| Company | Product | Status / Note |
|---|---|---|
| **PathAI** | AISight® Dx / Dx2 IMS | **FDA-cleared for primary diagnosis (Jun 2025)** — first IMS with authorized PCCP; Labcorp nationwide. ⚠️ **Already ships a product named "PathAssist Derm"** (FDA Breakthrough) — direct naming collision. |
| **Paige.AI** | Paige Prostate, PanCancer Detect, Virchow models | FDA-cleared prostate; PanCancer Detect Breakthrough (2025); co-developed Virchow/Virchow2 with Microsoft |
| **Proscia** | Concentriq® AP-Dx | FDA-cleared primary diagnosis (2024); $50M raise (2025); closest "platform + AI apps" analog |
| **Ibex Medical Analytics** | Galen Prostate/Breast | CE-marked AI cancer detection, widely deployed in labs |
| **Indica Labs** | HALO, HALO AP Dx, HALO Link | FDA-cleared with Leica Aperio GT450 DX; dominant quantitative analysis + IMS suite |
| **Aignostics** | Atlas foundation model, RudolfV | Charité spinout; Bayer partnership; foundation-model-first |
| **Owkin** | Phikon models + dx | Foundation models + drug-discovery dx |
| **Lunit** | SCOPE IO / PD-L1 | Strong in IHC/biomarker AI |
| **Others** | **Sectra**, **Philips IntelliSite** (first FDA-cleared WSI system), **Leica/Aperio**, **Roche (uPath/Ventana)**, **Aiforia**, **Visiopharm**, **Gestalt Diagnostics**, **Pramana**, **Tribun Health**, **Mindpeak**, **Deep Bio**, **Artera** (FDA-cleared breast risk stratification) | Scanner OEMs, IMS vendors, tissue-specific AI |

### 2.B Industry — AI copilot (closest to our Copilot panel)

- **Modella AI — PathChat / PathChat 2 / PathChat+** — the single most direct competitor to
  our copilot: conversational multimodal copilot for pathologists, published in *Nature* (2024),
  **FDA Breakthrough Device Designation (Jan 2025)**, and **acquired by AstraZeneca (Jan 2026)**.
  Same concept, but with a pathology-native trained model, regulatory traction, and
  Big Pharma backing. **Most strategically important competitor.**
- **Google Health AI / Path Foundation + MedGemma** — a latent platform competitor. MedGemma was
  also a runtime dependency until AskPA was removed; the Copilot path does not use it.

### 2.C Industry — Open-source / build-vs-buy alternatives

Because PathAssist is built *on* DSA, its "competitors" here double as self-host alternatives:

- **Digital Slide Archive / HistomicsUI** (Kitware) — the upstream PathAssist forks.
- **QuPath** (Queen's Belfast) — dominant free desktop WSI analysis tool.
- **Cytomine**, **OMERO + omero-iviewer**, **Orbit Image Analysis** — open web WSI platforms.

### 2.D Academia — Foundation models (encoder layer)

Direct competitors to the UNI / H-optimus-0 features the MIL models rely on (2025 benchmarks
rank these tightly):

- **Virchow / Virchow2** (Paige; 632M params, 3.1M slides) — top consistency, subtle-subtype leader
- **UNI / UNI2** (Mahmood Lab, Harvard/BWH) — currently used; non-commercial license is the catch
- **Prov-GigaPath** (Microsoft + Providence) — best on lung / pan-cancer
- **H-optimus-0/-1** (Bioptimus) — chosen *commercial* encoder (Apache 2.0); top on brain/breast
- **Atlas** (Mayo Clinic + Aignostics, 2025) — best average performance in its benchmark
- **PLUTO-4** (PathAI), **Phikon/Phikon2** (Owkin), **RudolfV** (Aignostics), **CTransPath**,
  **CONCH/TITAN/MUSK/THREADS** (Mahmood Lab multimodal)

### 2.E Academia — VLM copilots & agentic WSI systems

Where the group's agentic-pathology roadmap competes head-on (fast-moving 2025 frontier):

- **PathChat / PathChat+ / SlideSeek** (Mahmood Lab) — copilot + multi-agent autonomous navigation
- **SlideChat** — first VLM for gigapixel WSI conversational understanding
- **PathAgent**, **WSI-Agents**, **GIANT** (Gigapixel Image Agent for Navigating Tissue) —
  LLM-based agentic reasoning that navigates a WSI "like a pathologist"; directly overlaps the
  *"Adaptive Agentic Inference for WSIs"* proposal
- **Quilt-LLaVA**, **LLaVA-Med**, **PA-LLaVA**, **PathAsst** — pathology multimodal instruction-tuned models

### 2.F Academia — MIL methods & lymphoma-specific work

- **MIL aggregators** competing with **LCR-MIL / HG-MIL**: CLAM, TransMIL, DSMIL, DTFD-MIL, ABMIL, HIPT.
- **Lymphoma/DLBCL-specific**: Stanford **DLBCL-Morph**; transformer/self-attention DLBCL
  subtyping + survival pipelines (ASH/*Blood* 2023, *Lab Investigation* 2025, AUC ~0.77 outcome
  prediction). The DLBCL niche is **under-commercialized** — a genuine differentiation gap vs.
  the prostate/breast-saturated commercial market.

---

## 3. Strategic Read

**Strengths / white space**
- Lymphoma-first focus (commercially neglected)
- Multi-tenant white-label model (one backend, many branded labs)
- A genuinely integrated copilot, grounded in tool output rather than screenshots
  *(the **local/private, $0-egress LLM option** was AskPA's local Gemma 4 route and went with it on
  2026-08-03 — if the HIPAA-friendly angle is to be a selling point, it has to be rebuilt)*
- Direct pipeline from cutting-edge MIL research into product

**Biggest threats**
1. **Modella AI / PathChat (now AstraZeneca)** owns the copilot narrative with regulatory +
   pharma backing. Our copilot needs a differentiated wedge (lymphoma specialization, privacy/local
   inference, white-label) — it cannot out-model a pathology-native foundation model with
   off-the-shelf general LLMs.
2. **PathAI / Proscia / Indica** have **FDA clearance and lab distribution**. PathAssist is
   currently research/POC-grade (README flags "add metrics/logging before clinical production";
   DLBCL at AUC 0.681). Regulatory + clinical-validation is the incumbents' real moat.
3. **Naming collision** with PathAI's "PathAssist Derm" is a concrete commercial/branding risk
   to resolve early.

---

## 4. Sources

- PathAI — [AISight Dx FDA clearance](https://www.pathai.com/resources/pathai-receives-fda-clearance-for-aisight-dx-platform-for-primary-diagnosis) ·
  [PathAssist Derm Breakthrough](https://www.pathai.com/news/pathai-receives-u.s.-fda-breakthrough-device-designation-for-pathassist-derm-an-ai-powered-pathology-solution-to-transform-dermatopathology-workflow) ·
  [Labcorp deployment](https://ir.labcorp.com/news-releases/news-release-details/labcorp-expands-collaboration-pathai-deploy-fda-cleared-digital)
- [Indica Labs HALO AP Dx FDA clearance](https://indicalab.com/news/press-release/fda-cleared-digital-pathology/) ·
  [HALO Link](https://indicalab.com/halo-link/)
- [Top Imaging & Pathology AI Vendors 2025 (IntuitionLabs)](https://intuitionlabs.ai/articles/imaging-pathology-ai-vendors) ·
  [AI-Enabled Digital Pathology FDA milestones (DelveInsight)](https://www.delveinsight.com/blog/ai-enabled-digital-pathology-fda-milestones-market-growth)
- [Modella AI](https://www.modella.ai/) · [PathChat](https://www.modella.ai/pathchat) ·
  [PathChat — Nature 2024](https://www.nature.com/articles/s41586-024-07618-3) ·
  [PathChat 2 (VentureBeat)](https://venturebeat.com/ai/new-medical-llm-pathchat-2-can-talk-to-pathologists-about-tumors-offer-diagnoses)
- [Atlas foundation model (Mayo, arXiv)](https://arxiv.org/pdf/2501.05409) ·
  [PLUTO-4 (PathAI, arXiv)](https://arxiv.org/html/2511.02826v3) ·
  [Foundation model benchmark (medRxiv 2025)](https://www.medrxiv.org/content/10.1101/2025.05.08.25327250v1.full) ·
  [UNI (Mahmood Lab)](https://github.com/mahmoodlab/UNI)
- [PathAgent (arXiv)](https://arxiv.org/html/2511.17052) ·
  [Multi-agent pathology copilot / SlideSeek (arXiv)](https://arxiv.org/html/2506.20964v2) ·
  [SlideChat (arXiv)](https://arxiv.org/html/2410.11761v3) ·
  [WSI-Agents (arXiv)](https://arxiv.org/html/2507.14680v1)
- [Digital Slide Archive](https://digitalslidearchive.github.io/digital_slide_archive/) ·
  [Digital pathology software tools review (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9576980/)
- [DLBCL deep-learning WSI subtyping & survival (ASH/Blood)](https://ashpublications.org/blood/article/142/Supplement%201/904/503160/) ·
  [Deep learning WSI in cancer pathology (Lab Investigation 2025)](https://www.laboratoryinvestigation.org/article/S0023-6837(25)00096-0/abstract)
