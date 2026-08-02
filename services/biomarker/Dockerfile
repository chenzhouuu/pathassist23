# services/biomarker/Dockerfile — GigaTIME-Flash virtual-biomarker service (Flask).
#
# Base image is GPU-FREE (python:3.11-slim + flask/numpy/pillow, NO torch), like preprocess's
# base. With no weights it returns 503 on /phenotype; with BIOMARKER_DEV_STUB=1 it serves a
# deterministic dev stub so the whole phenotype path (tool → fusion → overlay) is browser-E2E-able
# with no GPU. The REAL GigaTIME-Flash path lives in Dockerfile.trident (torch + timm + gated
# weights on data2), selected by the compose override:
#   docker compose -f docker-compose.yml -f docker-compose.biomarker.yml up -d --build biomarker
FROM python:3.11-slim

RUN pip install --no-cache-dir flask "httpx>=0.27" numpy pillow gunicorn

WORKDIR /app
# Built from `services/` rather than from this directory, so that the one shared module can
# be copied in beside the service (Inc 6 · 09). It is put on the path rather than installed:
# a package with a version would be four services pinning four versions of the hundred lines
# of threading it was extracted to stop duplicating.
COPY biomarker/src ./src
COPY _shared/pathassist_jobs ./src/pathassist_jobs
ENV PYTHONPATH=/app/src
EXPOSE 8022

# 1 worker: the real model is a warm GPU singleton; extra workers would each reload it. The long
# timeout covers first-request model load + windowed mIF inference + the CellViT centroid fetch.
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8022", "--timeout", "600", \
     "biomarker_service.app:create_app()"]
