# services/cellvit/Dockerfile — CellViT-SAM-H inference service (GPU, Flask).
#
# Flask, NOT FastAPI: cellvit is built for pydantic v1 and breaks under the pydantic v2 that
# FastAPI pulls in (its LivePatchWSIConfig fails with "N validation errors ... missing"). Flask
# has no pydantic dependency, so the real CellViT model runs in-process behind the
# infer.segment_array seam with a warm singleton. (Validated on real H&E: 160 cells on the
# BRACS test tile, region-local coords — see the R11 GPU follow-up plan's spike verdict.)
FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime

# One install layer, pinned to the driver-535-compatible / cellvit-native combo:
#  - torch==2.2.2 (base's +cu121 build) pinned so cellvit's *unpinned* torch dep can't pull a
#    cu13x wheel that needs a newer NVIDIA driver than 535.
#  - pydantic==1.10.26 — cellvit's models are pydantic v1.
#  - openslide-bin — the bundled libopenslide 4.x (the distro's 3.4.1 is too old for
#    openslide-python 1.4.x).
#  - flask/httpx/numpy/pillow/tifffile/gunicorn — the Flask service (no pydantic v2 anywhere).
RUN pip install --no-cache-dir \
      "torch==2.2.2" \
      cellvit==1.0.9 "pydantic==1.10.26" openslide-bin \
      flask "httpx>=0.27" numpy pillow tifffile gunicorn

WORKDIR /app
# Built from `services/` rather than from this directory, so that the one shared module can
# be copied in beside the service (Inc 6 · 09). It is put on the path rather than installed:
# a package with a version would be four services pinning four versions of the hundred lines
# of threading it was extracted to stop duplicating.
COPY cellvit/src ./src
COPY _shared/pathassist_jobs ./src/pathassist_jobs
ENV PYTHONPATH=/app/src \
    CELLVIT_MODEL=cellvit \
    CELLVIT_CACHE=/weights-cache
EXPOSE 8020

# 1 worker: the CellViT-SAM-H model is a warm GPU singleton (~2.7 GB checkpoint); extra
# workers would each reload it. The long timeout covers first-request model load + the
# multi-tile inference of a region. The CellViT weight is mounted at CELLVIT_CACHE (compose).
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8020", "--timeout", "600", \
     "cellvit_service.app:create_app()"]
