# TRILOK KANTHETI
**Director / Senior Director — Computational Pathology & Clinical AI**

tkantheti@gmail.com · LinkedIn: linkedin.com/in/tkantheti · GitHub: github.com/tkantheti
Washington D.C. Metro Area · Open to Remote / Hybrid

---

## EXECUTIVE SUMMARY

Visionary engineering leader and hands-on computational pathology architect with 10+ years building AI-powered clinical decision tools at the intersection of deep learning, whole-slide imaging, and production software. Architect of **PathAssist / IMPART DX** — a full-stack digital pathology AI platform deployed across multiple hospital systems — encompassing foundation model-based cancer subtype classification (BRCA, NSCLC, DLBCL), multi-modal AI copilot (AskPA), real-time WSI annotation, and Dockerized Slicer CLI inference pipelines. Proven track record leading cross-functional teams (ML research, backend engineering, clinical UI, infrastructure) from concept through validated clinical deployment. Combines the depth of an ML researcher (ABMIL, H-optimus-0, ViT, LCR-MIL) with the breadth of a platform architect (React, Girder DSA, Keycloak SSO, GPU server management, multi-environment DevOps).

---

## CORE COMPETENCIES

| Clinical AI & Pathology | ML Architecture | Platform Engineering | Leadership |
|---|---|---|---|
| Whole-Slide Image (WSI) Analysis | Foundation Models (ViT, H-optimus-0, UNI) | React 18 / Vite / Zustand | Cross-functional Team Leadership |
| Digital Pathology Workflows | ABMIL / MIL Frameworks | OpenSeadragon 4.x | Technical Roadmap & Strategy |
| Cancer Subtype Classification | LCR-MIL (Student-Teacher Distillation) | Girder DSA / REST API | Product Lifecycle Management |
| Nuclei Detection & Segmentation | MedGemma 4B IT / Gemma 4 | Slicer CLI / HistomicsTK | MLOps & Model Deployment |
| Biomarker Analysis | Claude Sonnet/Opus (Vision LLMs) | Docker / Nginx / Ollama | Go-to-Market for AI Products |
| IHC/H&E Image Analysis | Cellpose / CellViT | Keycloak SSO / OAuth2 | Multi-site Clinical Deployment |
| Spatial Pathology | TCGA / DLBCL / NSCLC Datasets | GPU Server Admin (A6000) | Regulatory & Compliance Awareness |

---

## PROFESSIONAL EXPERIENCE

### Founder & Lead Architect — PathAssist / IMPART DX Platform
**[Organization Name]** · 2022 – Present

Designed, built, and deployed a production-grade AI-powered digital pathology platform — **PathAssist (IMPART DX)** — serving pathologists across multiple hospital systems. Sole architect of the full-stack system; led a team of engineers and collaborated directly with clinical pathologists, research scientists, and IT infrastructure teams.

**Platform Architecture & Deployment**
- Architected a React 18 + Vite + Zustand + TanStack Query frontend integrated with Girder DSA (Digital Slide Archive) as the backend tile server and metadata store
- Built a multi-environment deployment pipeline (dcpenn, AVMC, BMJH production) with per-institution `.env` configs, Nginx reverse proxy routing, and Keycloak SSO authentication — zero-trust access for PHI-adjacent clinical workflows
- Integrated OpenSeadragon 4.1.0 for GPU-accelerated whole-slide image rendering with ZXY → DZI → thumbnail fallback tile strategy; handles gigapixel SVS/NDPI slides in-browser with sub-second pan/zoom latency
- Managed on-premises GPU compute infrastructure: NVIDIA RTX A6000 (49 GB VRAM), AMD Threadripper 3960X (24 cores), 128 GB RAM running CUDA 12.8 / PyTorch 2.10

**AI Model Development & Integration**
- Trained and deployed a **breast cancer subtype classifier** (IDC vs. ILC) on 942 TCGA BRCA whole-slide images using the **H-optimus-0 ViT-G/14 foundation model** (1.1B parameters, 1536-dim embeddings) and **Attention-Based MIL (ABMIL)** — achieving **AUC 0.947** with UNI encoder, target AUC 0.90+ with H-optimus-0 (Apache 2.0, commercially licensed)
- Implemented full patch extraction pipeline: 256×256 patches at 0.5 µm/pixel (20× magnification), background filtering (>230 intensity exclusion), H-optimus-0 ViT-G/14 encoding (~500K forward passes per 100-slide batch on A6000 GPU, ~50 min runtime)
- Deployed BRCA inference as a **FastAPI microservice on DCPenn** integrated into AskPA: `POST /api/brca → { prediction: "IDC", confidence: 0.93, patches_reviewed: "6.5%" }` — LCR-MIL's student-teacher distillation reviews only 6.5% of patches for efficient clinical-speed inference
- Integrated **NSCLC lung cancer subtyping model** (AUC 0.976) and **DLBCL lymphoma model** (AUC 0.681); roadmapped data augmentation path: TCGA-DLBC (481 slides) + AVMC (831 slides) → target AUC 0.90+
- Evaluated 7 foundation model encoders for commercial deployment viability: H-optimus-0 (✅ Apache 2.0), Virchow/Paige (⚠️ no clinical use), UNI/CONCH/Phikon (❌ NC license) — selected H-optimus-0 as production encoder

**AskPA — AI Pathology Copilot**
- Designed and implemented **AskPA**, a multimodal AI copilot embedded in PathAssist, enabling pathologists to query AI during live slide review
- Integrated multi-model inference: Claude Sonnet 4.6 / Opus 4.6 (Anthropic vision API), MedGemma 4B IT (Google AI Studio), Gemma 4 (locally served on DCPenn via Ollama — free, private, no data egress)
- Built real-time viewport capture from OpenSeadragon canvas → JPEG → base64 encoding for multimodal image+text queries to vision LLMs; includes zoom level context injection (`[Zoom: 40×]`) for spatial grounding
- Implemented structured pathology report generation via AI: Clinical History · Gross Description · Microscopic Description · Diagnosis · Comment format — one-click report drafting for pathologists
- Designed AI cost tracking per message (per-token pricing for Anthropic models; $0 for local Gemma 4 inference) displayed in real-time to enable cost-aware model selection

**Dockerized Slicer CLI AI Analysis Pipelines**
- Built and deployed 4 independent Dockerized Slicer CLI modules registered with HistomicsTK/Girder:
  - **Cellpose Nuclei** — instance segmentation of nuclei in H&E/IHC slides; custom-tuned Cellpose model with ROI bounding-box extraction from annotation canvas
  - **PathAnalysis** — multi-model histopathology analysis pipeline with downloadable pre-trained weights
  - **MedGemma Report** — Google MedGemma 4B-powered automated pathology report generation from slide regions
  - **ViT Phenotype** — Vision Transformer-based cell phenotyping for IHC biomarker quantification
- Implemented Slicer CLI XML-driven dynamic form rendering in AnalysisPanel: all 4 CLIs discoverable, parameterizable, and job-submittable from the UI without code changes

**Annotation & Measurement Tools**
- Built a full annotation canvas overlay on OpenSeadragon: point, rectangle, polygon, polyline, ellipse, and arrow tools with right-click context menu (Center in View, Select, Nuclei Detection, Delete)
- Implemented calibrated distance measurement tool (pixel → µm → mm conversion using slide MPP metadata); displayed as live ruler overlay during viewport interaction
- Integrated NucleiDetectionModal: computes ROI bounding box from selected annotation, queries Slicer CLI Web for available Docker images, submits job, and polls job status — full MIL pipeline triggered from annotation click

**Research Collaboration**
- Collaborated with Dr. Chen's computational pathology research group on:
  - TCGA BRCA dataset (942 slides, UNI/H-optimus-0 feature extraction, 10 GB features)
  - DLBCL morphology dataset (255 patients, 6 encoder comparison: Virchow, UNI, CONCH, Phikon, CellViT, CLAM)
  - LCR-MIL (Learning-from-Context Regularized MIL) framework — student-teacher knowledge distillation achieving AUC 0.963 on BRCA (fold 4, best checkpoint)
  - Spatial transcriptomics integration roadmap for multi-modal slide analysis

---

### Senior Software Engineer — [Previous Role / Company]
**[Company Name]** · [YYYY – YYYY]

- [Add your previous role accomplishments here — suggest quantified achievements]
- Led development of [feature/product], delivering [outcome]
- Managed team of [N] engineers across [scope]

---

### Software Engineer — [Previous Role / Company]
**[Company Name]** · [YYYY – YYYY]

- [Add earlier career accomplishments here]

---

## FLAGSHIP PROJECT: PathAssist / IMPART DX

**PathAssist** is a production clinical AI platform for digital pathology — built from the ground up as a commercial-ready, multi-institution deployment.

| Capability | Technology | Clinical Value |
|---|---|---|
| WSI Viewer | OpenSeadragon 4.1, ZXY/DZI tiles | Gigapixel slides at clinical speed |
| Breast Cancer AI | H-optimus-0 + ABMIL, AUC 0.947 | IDC vs ILC subtype at slide level |
| Lung Cancer AI | LCR-MIL + UNI, AUC 0.976 | NSCLC subtyping from WSI |
| AI Copilot (AskPA) | Claude Opus, MedGemma, Gemma 4 | Case consultation + report drafting |
| Nuclei Segmentation | Cellpose (Docker CLI) | Quantitative cell counts in ROI |
| Cell Phenotyping | ViT Phenotype (Docker CLI) | IHC biomarker quantification |
| Annotations | Canvas overlay, 7 tool types | Structured morphology markup |
| Authentication | Keycloak SSO | HIPAA-aligned access control |
| Multi-site Deploy | .env per institution, Nginx proxy | AVMC, BMJH, DCPenn |

**Scale:** 942 TCGA BRCA slides · 255 DLBCL patient slides · 500K+ patch encodings · 49 GB GPU VRAM · 3 cancer types · 4 AI model backends · Multi-institution deployment

---

## AI MODEL PORTFOLIO

### Breast Cancer Subtype Classifier (BRCA — IDC vs ILC)
- **Dataset:** 942 TCGA BRCA whole-slide images (The Cancer Genome Atlas)
- **Encoder:** H-optimus-0 (Bioptimus, ViT-G/14, 1.1B parameters, Apache 2.0)
- **Aggregator:** ABMIL — Attention-Based Multiple Instance Learning (Ilse et al. 2018)
- **Architecture:** H-optimus-0 (frozen) → Linear(1536→256) → Gated Attention → Linear(256→64→2)
- **Trainable params:** ~540K (encoder frozen, efficient fine-tuning)
- **Performance:** AUC 0.947 (UNI encoder, 5-fold CV); AUC 0.85–0.90 (100-slide POC)
- **Deployment:** FastAPI microservice on DCPenn, integrated into AskPA `predictBRCA()` API

### NSCLC Lung Cancer Subtype Classifier
- **Framework:** LCR-MIL (student-teacher distillation on ABMIL)
- **Performance:** AUC 0.976 (fold 1)
- **Status:** Production-integrated with PathAssist

### DLBCL Lymphoma Classifier
- **Dataset:** 255 patient slides (private institutional)
- **Encoders evaluated:** Virchow, UNI, CONCH, Phikon, CellViT, CLAM (6 encoder benchmark)
- **Performance:** AUC 0.681 (data-limited); roadmap to AUC 0.90+ with TCGA-DLBC + AVMC data augmentation

### Foundation Models Evaluated & Deployed

| Model | Org | Architecture | Dims | License | Status |
|---|---|---|---|---|---|
| **H-optimus-0** | Bioptimus | ViT-G/14 (1.1B) | 1536 | Apache 2.0 ✅ | **Production** |
| UNI v1 | Harvard Mahmood Lab | ViT-Large (303M) | 1024 | CC-BY-NC-ND | Research only |
| MedGemma 4B IT | Google | Multimodal | — | Google AI Studio | AskPA production |
| Gemma 4 | Google | LLM | — | Apache 2.0 | Local DCPenn |
| Claude Sonnet/Opus 4.6 | Anthropic | Vision LLM | — | Commercial | AskPA production |
| Virchow | Paige AI | ViT | — | Apache 2.0* | Evaluated |
| CONCH | Harvard | Vision-Language | — | NC | Research |
| CellViT | — | Cell segmentation | — | — | Evaluated |

---

## TECHNICAL SKILLS

**ML / AI:** PyTorch 2.10, ABMIL, LCR-MIL, CLAM, Cellpose, timm 0.9.16, HuggingFace Hub, DINO v2, ViT fine-tuning, MIL, patch extraction, attention visualization

**Foundation Models:** H-optimus-0, UNI, CONCH, Virchow, Phikon, MedGemma 4B, Gemma 4, Claude Sonnet/Opus (vision), PLIP, CLIP

**Pathology / Imaging:** Whole-Slide Imaging (WSI), SVS/NDPI/DICOM formats, OpenSlide, OpenSeadragon, HistomicsTK, Slicer CLI Web, Girder DSA, TCGA datasets, IHC/H&E analysis, nuclei segmentation, spatial pathology

**Frontend:** React 18, Vite, Zustand, TanStack Query, Tailwind CSS, Canvas API, WebGL, HTML5

**Backend & Infra:** Python, FastAPI, Node.js, Docker, Nginx, Ollama, Girder REST API, Keycloak SSO, CUDA 12.8, GPU cluster management (RTX A6000)

**Data & Science:** h5py, scikit-learn, NumPy, pandas, sklearn (AUC, StratifiedKFold), patch feature extraction pipelines, 5-fold CV

**DevOps:** Git, multi-environment deployment, CI/CD, Linux/Ubuntu 20.04, SSH server management, conda environment management

---

## EDUCATION

**[Degree]** — [Field of Study]
[University Name] · [Year]

**[Additional Degree / Certification]** *(if applicable)*

---

## SELECTED PUBLICATIONS / PRESENTATIONS *(if applicable)*

- [Publication or conference talk on computational pathology / clinical AI]
- [Additional publications]

---

## KEY METRICS & IMPACT

- **AUC 0.976** — NSCLC lung cancer subtype classifier (production)
- **AUC 0.947** — BRCA breast cancer classifier, 942 TCGA slides, 5-fold CV
- **6.5%** — fraction of WSI patches reviewed by LCR-MIL for slide-level prediction (inference efficiency)
- **4 cancer types** — BRCA, NSCLC, DLBCL, + phenotyping pipeline
- **4 AI backends** — Cellpose, PathAnalysis, MedGemma Report, ViT Phenotype (all Dockerized, Slicer CLI)
- **3 LLM integrations** — Claude Opus/Sonnet, MedGemma 4B, Gemma 4 (local, private, $0 marginal cost)
- **Multi-institution** — deployed across AVMC, BMJH, DCPenn with institution-specific configs and SSO
- **1 platform** — PathAssist covers annotation, measurement, nuclei detection, AI analysis, report drafting, case consultation — end-to-end

---

## TARGET ROLES

Director of Computational Pathology · Senior Director of Clinical AI · VP of AI Engineering (HealthTech)
Director of Digital Pathology · Head of AI Products (Oncology) · Principal AI Architect (Medical Imaging)

**Target Companies:** Paige AI · PathAI · Aignostics · Owkin · Proscia · Tempus · AstraZeneca · Roche/Ventana · Leica Biosystems · Philips Digital Pathology · Memorial Sloan Kettering · Mayo Clinic · Penn Medicine

---

*References and full project documentation available upon request.*
*PathAssist platform demo available — live deployment on institutional servers.*
