# DCPenn Server — Setup Log
**Server:** DCPenn (`ssh dcpenn` → `192.168.191.109`)  
**Account used:** `path01`  
**Date:** 2026-04-07  
**Purpose:** BRCA breast cancer POC training + Gemma 4 local LLM

> **Status note (2026-08-03):** the server side below is unchanged and still describes how these
> services were built. What went is their **caller** — the AskPA panel was removed, so neither the
> Gemma chat server (`:11500`) nor the BRCA classifier (`:11501`) has a frontend entry point any
> more. §10 describes UI changes that have since been reverted.
> See `docs/askpa-technical-report.md`.

---

## 1. Server Specs

| Component | Detail |
|-----------|--------|
| GPU | NVIDIA RTX A6000 — 49 GB VRAM |
| CPU | AMD Threadripper 3960X — 24 cores |
| RAM | 128 GB DDR4 |
| Root disk | Samsung 970 EVO Plus 2 TB — `/` (468 GB free at setup time) |
| Data disk | Samsung 990 PRO 4 TB — `/home/chen/data2` (963 GB free) |
| CUDA | 12.8 |
| OS | Ubuntu 20.04 |

---

## 2. Conda Environment

`path01` does **not** have conda in PATH by default.  
Chen's miniconda is at `/home/chen/miniconda3/`. We use it directly.

### One-time setup (added to `~/.bashrc`)
```bash
echo 'source /home/chen/miniconda3/etc/profile.d/conda.sh' >> ~/.bashrc
source ~/.bashrc
```

### Activating the pathology environment
```bash
conda activate pathology
# Python 3.10.19 | PyTorch 2.10.0+cu128 | timm 0.9.16 | CUDA 12.8
```

### Verifying
```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 2.10.0+cu128  True
```

---

## 3. BRCA POC — Python Packages Used

All packages were **already installed** in Chen's `pathology` conda env.  
No new packages were needed for the BRCA training POC.

| Package | Version | Use |
|---------|---------|-----|
| torch | 2.10.0+cu128 | Model training |
| h5py | (pre-installed) | Reading `.h5` feature files |
| scikit-learn | (pre-installed) | AUC, accuracy, StratifiedKFold |
| numpy | (pre-installed) | Array operations |

---

## 4. BRCA POC — Data Sources

### Feature files (pre-extracted by Chen)
```
/home/chen/MIL-Lab/trident_processed/tcga_brca/
  20x_256px_0px_overlap/
    features_uni_v1/        ← 942 .h5 files, each: features=(N,1024), coords=(N,2)
```

### Labels — fetched live from GDC public API
```bash
# No auth needed. GDC API is public.
curl -s -X POST https://api.gdc.cancer.gov/cases \
  -H 'Content-Type: application/json' \
  -d '{"filters":{"op":"=","content":{"field":"project.project_id","value":"TCGA-BRCA"}},
       "fields":"submitter_id,diagnoses.primary_diagnosis","size":"2000"}'
```
- Returned 942 cases: IDC=753, ILC=189
- Saved to `/home/path01/brca-poc/brca_labels.csv`

### Raw WSIs (for future H-optimus-0 extraction)
```
/home/chen/data2/tcga_brca/wsis_idc_ilc_all/*.svs   ← 942 SVS files
```

---

## 5. BRCA POC — Scripts Deployed

All scripts written directly on DCPenn via SSH (no SCP).  
Location: `/home/path01/brca-poc/`

| Script | Purpose |
|--------|---------|
| `01_create_subset.py` | Sample 50 IDC + 50 ILC from 942 slides → `brca_poc_subset.csv` |
| `02_train_poc.py` | Train ABMIL on 100-slide subset (33 sec, AUC=0.98) |
| `train_full.py` | 5-fold CV ABMIL on all 942 slides (46 min, AUC=0.962) |
| `03_inference_demo.py` | Run inference on a single slide |
| `run_poc.sh` | Runner script that sources conda and runs steps in order |

### How scripts were written on the server
```bash
# Written via SSH heredoc — no SCP needed
ssh dcpenn "cat > /home/path01/brca-poc/train_full.py << 'PYEOF'
...script content...
PYEOF"
```

---

## 6. BRCA Training — How to Run

```bash
ssh dcpenn
source ~/.bashrc          # loads conda (added in step 2)
conda activate pathology
cd /home/path01/brca-poc

# POC: 100 slides, 33 seconds
python 02_train_poc.py --encoder uni

# Full: 942 slides, 5-fold CV, ~46 min — runs in tmux (survives disconnect)
tmux new-session -d -s brca_train 'python train_full.py 2>&1 | tee train_full.log'

# Monitor
tmux attach -t brca_train           # watch live (Ctrl+B then D to detach)
tail -f /home/path01/brca-poc/train_full.log   # or just tail the log
```

### Results achieved
| Fold | AUC | Accuracy |
|------|-----|----------|
| 0 | 0.9510 | 90.5% |
| 1 | 0.9556 | 90.5% |
| 2 | 0.9814 | 93.6% |
| 3 | 0.9702 | 91.5% |
| 4 | 0.9537 | 91.0% |
| **Mean** | **0.9624 ± 0.012** | **91.4%** |

Checkpoints: `/home/path01/brca-poc/outputs_full/fold{0-4}_abmil.pt`

---

## 7. Ollama Installation

### Problem encountered
```
ERROR: This version requires zstd for extraction.
```

### Fix
```bash
sudo apt-get install -y zstd
```

### Install Ollama
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### What the installer did
- Installed Ollama binary to `/usr/local/bin/ollama`
- Created `ollama` system user
- Added `ollama` user to `render` and `video` groups (for GPU access)
- Created and enabled `ollama.service` (systemd)
- Detected NVIDIA GPU automatically

### Verify
```bash
ollama --version        # ollama version is 0.20.3
systemctl is-active ollama   # active
```

Ollama runs as a background service on port `11434` (localhost only by default).

---

## 8. Gemma 4 Model Download (via Ollama)

Gemma 4 is available in Ollama as `gemma4` (9.6 GB GGUF, Q4 quantized).  
This is the official Google Gemma 4 model served by Ollama on the A6000.

> **Why Ollama instead of HuggingFace?**  
> The HuggingFace `google/gemma-4-26B-A4B-it` model (128-expert MoE) requires  
> ~52 GB in BF16 which exceeds the A6000's 49 GB VRAM. Ollama's GGUF version  
> is 9.6 GB and fits comfortably. Gemma 3 27B (17 GB) is also available.

### Pull commands (run in tmux)
```bash
# Gemma 4 via Ollama — 9.6 GB, recommended
tmux new-session -d -s gemma4_pull \
  'ollama pull gemma4 > /home/path01/gemma4_pull.log 2>&1'

# Gemma 3 27B also available as fallback
# ollama pull gemma3:27b
```

### Verify when done
```bash
ollama list
# NAME           ID            SIZE    MODIFIED
# gemma4:latest  ...           9.6 GB  ...
# gemma3:27b     ...           17 GB   ...
```

---

## 9. Gemma FastAPI Server

### Packages installed
```bash
source /home/path01/miniconda3/etc/profile.d/conda.sh
conda activate pathassist   # path01's own env (not Chen's)
pip install fastapi uvicorn httpx
```

| Package | Version |
|---------|---------|
| fastapi | 0.135.3 |
| uvicorn | 0.44.0 |
| httpx | 0.28.1 |

### Server script
Written directly on server: `/home/path01/gemma_server.py`

```bash
# Start in tmux (survives SSH disconnect)
tmux new-session -d -s gemma_server \
  'cd /home/path01 && \
   source /home/path01/miniconda3/etc/profile.d/conda.sh && \
   conda activate pathassist && \
   MODEL_NAME=gemma4 python gemma_server.py 2>&1 | tee gemma_server.log'
```

### What it does
- Listens on `0.0.0.0:11500`
- Receives chat requests over HTTP (the PathAssist AskPA panel was the caller until 2026-08-03)
- Converts Anthropic-format messages → Ollama `/api/chat` format
- Calls local Ollama at `localhost:11434` with `MODEL_NAME` (default: `gemma4`)
- Returns `{ text, usage }` — same shape as Claude/MedGemma responses
- Can also serve `gemma3:27b` by setting `MODEL_NAME=gemma3:27b`

### Health check
```bash
curl -s http://localhost:11500/health
# {"status":"ok","ollama":"up","gemma_ready":true,"models":["gemma3:27b"]}
```

### Test chat
```bash
curl -s -X POST http://localhost:11500/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "system": "You are AskPA, a pathology AI copilot.",
    "messages": [{"role":"user","content":[{"type":"text","text":"What is IDC breast cancer?"}]}]
  }' | python3 -m json.tool
```

---

## 10. PathAssist UI Changes — reverted 2026-08-03

Every frontend change from this session has been undone. `src/api/pathChatApi.js` and
`src/components/panels/PathChatPanel.jsx` are deleted; `VITE_DCPENN_LLM_URL`,
`VITE_DCPENN_BRCA_URL`, and `VITE_ENABLED_CHAT_MODELS` are read by nothing and were dropped from
`deploy/.env.example`. `VITE_ANTHROPIC_API_KEY` and `VITE_GEMINI_API_KEY` stay — they still power
the Ki67 analysis paths.

To reach the Gemma server now, call it directly:

```bash
curl -s http://192.168.191.109:11500/health
```

See `docs/askpa-technical-report.md` for what the panel was and what it would take to rebuild.

---

## 11. Active tmux Sessions on DCPenn

```bash
tmux list-sessions      # see all running sessions
tmux attach -t <name>   # attach (Ctrl+B then D to detach)
```

| Session | Purpose |
|---------|---------|
| `gemma_server` | FastAPI Ollama bridge on port 11500 — keep running |
| `gemma4_pull` | Download gemma4 (9.6 GB) — exits when done |
| `brca_train` | BRCA 5-fold CV training — exits when done |

---

## 12. Restart After Server Reboot

If DCPenn reboots, Ollama auto-starts (systemd). The FastAPI bridge server needs to be manually restarted:

```bash
ssh dcpenn
source /home/path01/miniconda3/etc/profile.d/conda.sh && conda activate pathassist
tmux new-session -d -s gemma_server \
  'cd /home/path01 && MODEL_NAME=gemma4 python gemma_server.py 2>&1 | tee gemma_server.log'
```

To make it auto-start on reboot, add a systemd service:
```bash
# Ask Chen or sysadmin to create /etc/systemd/system/gemma-askpa.service
```

---

## 13. Key Paths Reference

```
BRCA POC workspace:     /home/path01/brca-poc/
  Labels CSV:           /home/path01/brca-poc/brca_labels.csv
  Subset manifest:      /home/path01/brca-poc/brca_poc_subset.csv
  POC checkpoint:       /home/path01/brca-poc/outputs/abmil_brca_poc_uni.pt
  Full CV checkpoints:  /home/path01/brca-poc/outputs_full/fold{0-4}_abmil.pt
  Training log:         /home/path01/brca-poc/train_full.log

Gemma server:           /home/path01/gemma_server.py
  Server log:           /home/path01/gemma_server.log
  Pull log:             /home/path01/gemma_pull.log
  Ollama models dir:    /usr/share/ollama/.ollama/models/

Chen's UNI features:    /home/chen/MIL-Lab/trident_processed/tcga_brca/
                          20x_256px_0px_overlap/features_uni_v1/*.h5
Chen's raw WSIs:        /home/chen/data2/tcga_brca/wsis_idc_ilc_all/*.svs
Chen's HF model cache:  /home/chen/.cache/huggingface/hub/
```
