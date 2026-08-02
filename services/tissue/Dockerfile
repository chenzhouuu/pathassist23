# services/tissue/Dockerfile — the GPU-free base image (Inc 4).
#
# Serves /tissue/catalog, /tissue/<...>/meta, the tile routes and /tissue/<...>/stats over an
# artifact that already exists, and answers POST /tissue with 503. Use Dockerfile.trident for the
# image that can actually compute a map.
FROM python:3.11-slim

RUN pip install --no-cache-dir flask "httpx>=0.27" "numpy<2" pillow gunicorn

WORKDIR /app
# Built from `services/` rather than from this directory, so that the one shared module can
# be copied in beside the service (Inc 6 · 09). It is put on the path rather than installed:
# a package with a version would be four services pinning four versions of the hundred lines
# of threading it was extracted to stop duplicating.
COPY tissue/src ./src
COPY _shared/pathassist_jobs ./src/pathassist_jobs
ENV PYTHONPATH=/app/src
EXPOSE 8023

# One worker, many threads. The worker count must stay 1: the JobQueue and the loaded model live
# in the process, so a second worker would answer /tissue/status for a job it has never heard of.
# Threads are the axis that is safe — the queue is lock-guarded, tile writes land by rename, and
# tile rendering is pure file-read plus numpy. Pillow releases the GIL while it encodes, so this
# parallelises for real (measured: 7.3x at 8 threads).
ENV TISSUE_THREADS=8
CMD ["sh", "-c", "exec gunicorn -w 1 --threads ${TISSUE_THREADS:-8} -b 0.0.0.0:8023 \
     --timeout 900 'tissue_service.app:create_app()'"]
