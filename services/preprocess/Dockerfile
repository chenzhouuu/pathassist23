# services/preprocess/Dockerfile — Trident WSI preprocessing service (Flask).
#
# Runs the GPU-FREE STUB pipeline by default (a deterministic synthetic index) so the whole path
# — resolve → segment → patch → encode → sink → status, plus find_regions retrieval — is
# deployable and browser-E2E-able with NO GPU/Trident, exactly like the cellvit (R8→R11) and
# MedGemma (Inc 2a) stub seams.
#
# The REAL Trident+CONCH path lives in a SEPARATE image, `Dockerfile.trident` (driver-535 GPU base
# + Trident + CONCH, weight caches on data2). Enable it via the compose override:
#   docker compose -f docker-compose.yml -f docker-compose.trident.yml up -d --build preprocess
# CONCH text search needs conch_v1 built with projection (F1); see Dockerfile.trident.
FROM python:3.11-slim

RUN pip install --no-cache-dir flask "httpx>=0.27" numpy h5py gunicorn

WORKDIR /app
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8030

# 1 worker: the single-consumer job queue lives in-process (it serializes GPU work against the
# coresident CellViT + MedGemma). The long timeout covers first-request model load + feature
# extraction on the real path.
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8030", "--timeout", "1200", \
     "preprocess_service.app:create_app()"]
