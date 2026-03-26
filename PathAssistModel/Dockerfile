FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv python3-dev \
    build-essential git curl \
    libgl1 libglib2.0-0 libopenslide0 openslide-tools \
    libvips42 libvips-tools default-jre \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --upgrade pip wheel setuptools && \
    python3 -m pip install -r /app/requirements.txt

COPY app /app/app
COPY worker /app/worker

EXPOSE 8081

CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081"]
