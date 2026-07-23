# services/preprocess/Dockerfile — Trident WSI preprocessing service (Flask).
#
# Runs the GPU-FREE STUB pipeline by default (a deterministic synthetic index) so the whole path
# — resolve → segment → patch → encode → sink → status, plus find_regions retrieval — is
# deployable and browser-E2E-able with NO GPU/Trident, exactly like the cellvit (R8→R11) and
# MedGemma (Inc 2a) stub seams.
#
# The REAL Trident+CONCH path lands behind the infer seam (PREPROCESS_USE_TRIDENT=1). Enabling it
# means switching to the driver-535 GPU base and installing Trident + the conch/musk encoder
# extras (see the commented block) — CONCH text search needs conch_v1 built with projection (F1).
FROM python:3.11-slim

RUN pip install --no-cache-dir flask "httpx>=0.27" numpy h5py gunicorn

# --- Real Trident+CONCH path (swap the base above + uncomment to enable PREPROCESS_USE_TRIDENT=1):
# FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime
# RUN apt-get update && apt-get install -y --no-install-recommends openslide-tools \
#       && rm -rf /var/lib/apt/lists/*
# RUN pip install --no-cache-dir "torch==2.2.2" "timm==0.9.16" openslide-python h5py flask \
#       "httpx>=0.27" numpy gunicorn \
#       "git+https://github.com/mahmoodlab/TRIDENT.git" \
#       "git+https://github.com/Mahmoodlab/CONCH.git"

WORKDIR /app
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8030

# 1 worker: the single-consumer job queue lives in-process (it serializes GPU work against the
# coresident CellViT + MedGemma). The long timeout covers first-request model load + feature
# extraction on the real path.
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8030", "--timeout", "1200", \
     "preprocess_service.app:create_app()"]
