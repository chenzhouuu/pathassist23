# services/tissue/Dockerfile — the GPU-free base image (Inc 4).
#
# Serves /tissue/catalog, /tissue/<...>/meta, the tile routes and /tissue/<...>/stats over an
# artifact that already exists, and answers POST /tissue with 503. Use Dockerfile.trident for the
# image that can actually compute a map.
FROM python:3.11-slim

RUN pip install --no-cache-dir flask "httpx>=0.27" "numpy<2" pillow gunicorn

WORKDIR /app
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8023

CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8023", "--timeout", "900", \
     "tissue_service.app:create_app()"]
