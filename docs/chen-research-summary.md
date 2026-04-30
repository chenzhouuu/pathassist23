# Chen's Computational Pathology Research — Summary Document

**Prepared:** 2026-04-04  
**Server:** DCPenn on-prem (`192.168.191.109`, `ssh dcpenn`)  
**Researcher:** Chen (user: `chen`)  
**Relevance:** Direct integration path into PathAssist / AskPA / Impart DX

---

## 1. Server Infrastructure

| Component | Spec |
|---|---|
| **GPU** | NVIDIA RTX A6000 — 49 GB VRAM |
| **CPU** | AMD Threadripper 3960X — 24 cores |
| **RAM** | 128 GB DDR4 (8 × 16 GB, all slots full, max 512 GB) |
| **Root disk** | Samsung 970 EVO Plus 2 TB — ⚠️ 99% full (19 GB free) |
| **Data disk** | Samsung 990 PRO 4 TB — mounted at `/home/chen/data2`, 1.4 TB free |
| **CUDA** | 12.8 |
| **PyTorch** | 2.10.0+cu128 |
| **Python env** | `conda activate pathology` (timm 0.9.16) |

---

## 2. Foundation Models Available on DCPenn

All models are pre-downloaded in `/home/chen/.cache/huggingface/hub/` (~43 GB total).

| Model | Owner | Size | License | Commercial? | Purpose |
|---|---|---|---|---|---|
| **UNI** | MahmoodLab (Harvard) | 1.2 GB | CC-BY-NC-ND 4.0 | ❌ No | Pathology patch embeddings |
| **CONCH** | MahmoodLab | — | CC-BY-NC-ND 4.0 | ❌ No | Vision-language pathology |
| **Virchow** | Paige AI | — | Apache 2.0 | ✅ Yes* | Pathology encoder (*no clinical use) |
| **Phikon** | Owkin | — | Non-commercial | ❌ No | Pathology encoder |
| **Gemma 2 9B IT** | Google | — | Gemma ToS | Limited | General LLM |
| **CLIP variants** | OpenAI/LAION | — | Various | Varies | Vision-language |
| **PLIP** | vinid | — | — | — | Pathology-language |

### UNI — Key Technical Specs
- **Architecture:** ViT-Large, 303M parameters
- **Output:** 1024-dimensional embedding per patch
- **Input:** 224×224 px patches at 20× magnification
- **Training:** DINOv2 self-supervised on 100M+ patches from 100,402 WSIs (MGH + BWH private + GTEx public)
- **License contact:** faisalmahmood@bwh.harvard.edu

### H-optimus-0 — Recommended Commercial Replacement
- **Owner:** Bioptimus
- **License:** Apache 2.0 ✅ fully commercial, no clinical restrictions
- **Architecture:** ViT-G/14, 1.1B parameters (4× larger than UNI)
- **Output:** 1536-dimensional embedding per patch
- **Input:** 224×224 px at 0.5 microns/pixel
- **Status:** Gated on HuggingFace (request access at huggingface.co/bioptimus/H-optimus-0)
- **Note:** Requires retraining LCR-MIL with `in_dim=1536` (was 1024 for UNI)

---

## 3. Datasets Processed

All data at `/home/chen/MIL-Lab/trident_processed/` (188 GB total).

### TCGA BRCA (Breast Cancer)
- **Source:** The Cancer Genome Atlas — public
- **Slides:** 942 WSIs
- **Task:** IDC vs ILC subtype classification (binary)
- **Patch extraction:** 20× magnification, 256×256 px, non-overlapping
- **Features extracted with 1 encoder:**

| Encoder | Feature dir | Size |
|---|---|---|
| UNI v1 | `features_uni_v1/` | 10 GB |

### DLBCL Morphology (Lymphoma)
- **Source:** Private (DCPenn/institutional) — 255 patients
- **Task:** Morphology subtype classification + survival prediction
- **Patch extraction:** 20× magnification, 256×256 px
- **Features extracted with 6 encoders:**

| Encoder | Feature dir | Size |
|---|---|---|
| Virchow | `features_virchow/` | 17 GB |
| UNI v1 | `features_uni_v1/` | 6.9 GB |
| ResNet-50 | `features_resnet50/` | 6.9 GB |
| Phikon | `features_phikon/` | 5.3 GB |
| CTransPath | `features_ctranspath/` | 5.3 GB |
| CONCH v1 | `features_conch_v1/` | 3.6 GB |

---

## 4. Models Trained — Results

### 4a. TCGA BRCA — LCR-MIL (UNI features)
**Location:** `/home/chen/hgmil/lcr-mil/outputs/tcga_brca_v2/`  
**Task:** IDC vs ILC breast cancer subtype classification  
**Model weights:** `fold{0-4}/lcr_mil/best_student_fold{N}.pt`

| Fold | Student AUC | Teacher AUC | Accuracy | Patches Used |
|---|---|---|---|---|
| 0 | 0.933 | 0.946 | 92.1% | 6.1% |
| 1 | 0.938 | 0.929 | 89.4% | 5.9% |
| 2 | 0.939 | 0.952 | 90.4% | 7.6% |
| 3 | 0.961 | 0.973 | 88.3% | 6.6% |
| 4 | **0.963** | **0.966** | **90.1%** | 6.5% |
| **Mean** | **0.947 ± 0.013** | **0.953 ± 0.017** | **90.1%** | **6.5%** |

**Key insight:** Model achieves 94.7% AUC looking at only **6.5% of patches** per slide.

---

### 4b. TCGA NSCLC — LCR-MIL (UNI features)
**Location:** `/home/chen/hgmil/lcr-mil/outputs/tcga_nsclc_run/`  
**Task:** Lung cancer subtype classification (LUAD vs LUSC)

| Fold | Student AUC | Teacher AUC | Patches Used |
|---|---|---|---|
| 0 | 0.972 | 0.972 | 10.1% |
| 1 | **0.987** | **0.991** | 10.4% |
| 2 | 0.961 | 0.971 | 10.2% |
| 3 | 0.985 | 0.988 | 10.1% |
| **Mean** | **0.976 ± 0.011** | **0.980 ± 0.009** | **10.2%** |

**Exceptional results — 97.6% AUC on lung cancer subtyping.**

---

### 4c. DLBCL Morphology Classification — LCR-MIL (UNI features)
**Location:** `/home/chen/hgmil/lcr-mil/outputs/lcr_dlbcl_uni/`  
**Task:** DLBCL morphology subtype classification (binary)  
**Dataset:** 255 slides (~104 train / 26 val per fold)

| Metric | Dense Teacher | LCR-MIL Student |
|---|---|---|
| AUC | 0.672 ± 0.080 | **0.681 ± 0.081** |
| Accuracy | 60.1% | 61.8% |
| F1 | 0.479 | 0.525 |
| Patches used | 100% | **14.8%** |

**Why lower than BRCA/NSCLC:** Only 255 slides (vs 942 BRCA). More data needed.

---

### 4d. DLBCL Survival Prediction — Foundation Model Benchmark
**Location:** `/home/chen/lym_mil/`  
**Task:** Overall survival prediction (log-rank test on 255 patients)

| Foundation Model | Test Statistic | p-value | Significance |
|---|---|---|---|
| Lymphomer (custom) | 137.59 | < 0.0001 | *** |
| CTransPath | 71.89 | < 0.0001 | *** |
| **UNI** | **68.39** | **< 0.0001** | *** |
| Virchow | 41.55 | < 0.0001 | *** |
| HIPT | 20.66 | < 0.0001 | *** |
| Prov-GigaPath | 10.42 | 0.0012 | ** |
| Phikon | 7.10 | 0.0077 | ** |

**UNI ranks 3rd for lymphoma survival prediction.** Custom Lymphomer model (trained specifically on lymphoma) outperforms all general-purpose foundation models.

---

### 4e. DLBCL Multi-Encoder Comparison (various MIL methods)
Additional experiments comparing encoders across DSMIL and TransMIL aggregators:

| Experiment | Location |
|---|---|
| CONCH + DSMIL on DLBCL | `lcr_dlbcl_conch_v1_dsmil/` |
| CTransPath + DSMIL | `lcr_dlbcl_ctranspath_dsmil/` |
| Phikon + DSMIL | `lcr_dlbcl_phikon_dsmil/` |
| ResNet-50 + DSMIL | `lcr_dlbcl_resnet50_dsmil/` |
| UNI + DSMIL | `lcr_dlbcl_uni_dsmil/` |
| UNI + TransMIL | `lcr_dlbcl_uni_transmil/` |
| Virchow + DSMIL | `lcr_dlbcl_virchow_dsmil/` |

---

## 5. Chen's Research Papers

### Paper 1 — HG-MIL (CVPR submission)
**Location:** `/home/chen/hgmil/hg-mil/`  
**Title:** "HG-MIL: Hierarchical Gated Self-Attention MIL for WSI Classification"  
**Abstract:** Proposes a hierarchical gated self-attention mechanism for dynamic instance sampling in MIL. Uses entropy minimization + self-distillation. Tested on CAMELYON16 and TCGA Lung Cancer — state-of-the-art AUC.

### Paper 2 — LCR-MIL (Active Research)
**Location:** `/home/chen/hgmil/lcr-mil/`  
**Full name:** "Language-Conditioned Coverage-Rate Distortion MIL for Adaptive Evidence Acquisition"  
**arxiv:** arXiv-2504.13837v5 (tarball in `/home/chen/hgmil/`)  
**Core idea:** Train a student to match teacher accuracy using only 6–15% of patches via adaptive halting. Teacher (ABMIL) processes 100% patches. Student learns which patches to skip.

### Paper 3 — Agentic Pathology (Research Proposal)
**Location:** `/home/chen/hgmil/lcr-mil/plan/`  
**Title:** "Adaptive Agentic Inference for WSIs: When to Think, Where to Look, and When to Stop"  
**Key idea:** Easy slides → fast MIL. Hard slides → agentic multi-step reasoning. Gate learns which path to take. Targets NeurIPS/ICML.

---

## 6. Conda Environments on DCPenn

| Env name | Use case |
|---|---|
| `pathology` | Main — timm 0.9.16 + PyTorch 2.10 + CUDA 12.8, UNI works here |
| `pathchat` | PathChat pipeline |
| `cellvit` | CellViT nuclei segmentation |
| `clam_latest` | CLAM MIL framework |
| `huggingface` | General HF experiments |
| `llava` | LLaVA multimodal |
| `omeroenv` | OMERO server |

---

## 7. Licensing Summary

| Model | License | Commercial use for Impart DX |
|---|---|---|
| UNI | CC-BY-NC-ND 4.0 | ❌ **Not allowed** |
| CONCH | CC-BY-NC-ND 4.0 | ❌ Not allowed |
| Phikon | Non-commercial | ❌ Not allowed |
| Virchow | Apache 2.0 | ⚠️ Allowed but **no clinical/diagnostic use** |
| **H-optimus-0** | **Apache 2.0** | ✅ **Fully allowed, no restrictions** |
| CTransPath | MIT | ✅ Allowed |
| ResNet-50 | BSD | ✅ Allowed |

### To use UNI commercially:
Contact: **faisalmahmood@bwh.harvard.edu** (Faisal Mahmood, Mahmood Lab, Harvard/BWH)

---

## 8. Path to Commercial Deployment (H-optimus-0 Replacement)

### Step 1 — Request H-optimus-0 access
Visit huggingface.co/bioptimus/H-optimus-0 → Request Access (Apache 2.0, auto-approved)

### Step 2 — Extract features (1–2 hrs on A6000)
```bash
ssh dcpenn
sudo -u chen -i bash
conda activate pathology
cd /home/chen/MIL-Lab
python trident/extract_features.py \
    --slides_dir /path/to/tcga_brca \
    --output_dir trident_processed/tcga_brca/20x_256px_0px_overlap/features_hoptimus0 \
    --encoder hf-hub:bioptimus/H-optimus-0 \
    --patch_size 256 --target_mpp 0.5 --device cuda
```

### Step 3 — Retrain LCR-MIL with in_dim=1536 (2–3 hrs)
```bash
cd /home/chen/hgmil/lcr-mil
CUDA_VISIBLE_DEVICES=0 python scripts/run_all_folds.py \
    --feature_dir /home/chen/MIL-Lab/trident_processed/tcga_brca/20x_256px_0px_overlap/features_hoptimus0/ \
    --output_dir outputs/tcga_brca_hoptimus0 \
    --dataset tcga_brca --in_dim 1536
```

### Step 4 — Deploy as FastAPI on DCPenn → AskPA calls it
Expected output: `{ prediction: "IDC", confidence: 0.96, patches_reviewed: "6.5%" }`

### Expected timeline: 4–6 hours total

---

## 9. Relevance to PathAssist / AskPA / Impart DX

| Chen's Asset | PathAssist Use |
|---|---|
| BRCA model (AUC 0.947) | Breast cancer slide confidence score in AskPA |
| NSCLC model (AUC 0.976) | Lung cancer subtyping in AskPA |
| DLBCL model (AUC 0.681) | Lymphoma classification — needs more data |
| UNI features pipeline | Extract features from AVMC/BMJH slides |
| LCR-MIL framework | Efficient inference — 6.5% patches = fast API |
| Survival benchmark | Guide which encoder to pick per cancer type |
| Agentic research | Future AskPA multi-step reasoning architecture |

### Data needed to reach 90% AUC on DLBCL:
- Current: 255 slides → AUC 0.681
- Add TCGA-DLBC (public, 481 slides) → est. AUC ~0.80
- Add AVMC (831 slides in Girder) → est. AUC ~0.87
- Add BMJH (pending import) → est. AUC ~0.90+

---

## 10. Quick Reference — Key Paths

```
Models (trained weights):
  BRCA:  /home/chen/hgmil/lcr-mil/outputs/tcga_brca_v2/fold4/lcr_mil/best_student_fold4.pt
  NSCLC: /home/chen/hgmil/lcr-mil/outputs/tcga_nsclc_run/fold1/lcr_mil/best_student_fold1.pt
  DLBCL: /home/chen/hgmil/lcr-mil/outputs/lcr_dlbcl_uni/fold1/lcr_mil/best_student_fold1.pt

Features (UNI embeddings):
  BRCA:  /home/chen/MIL-Lab/trident_processed/tcga_brca/20x_256px_0px_overlap/features_uni_v1/
  DLBCL: /home/chen/MIL-Lab/trident_processed/dlbcl_morph/20x_256px_0px_overlap/features_uni_v1/

Code:
  LCR-MIL:  /home/chen/hgmil/lcr-mil/
  lym_mil:  /home/chen/lym_mil/
  MIL-Lab:  /home/chen/MIL-Lab/

HuggingFace cache: /home/chen/.cache/huggingface/hub/ (43 GB)

SSH: ssh dcpenn  →  path01@192.168.191.109
```
