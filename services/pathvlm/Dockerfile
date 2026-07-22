# services/pathvlm/Dockerfile — pathology VLM service (GPU, Flask).
#
# Hosts the Perceptor (Patho-R1-7B, a Qwen2.5-VL pathology model) now and the Navigator (PLIP)
# later, in-process behind the infer.describe_array stub seam with a warm singleton.
# torch/transformers live only here and are imported lazily on the real path, so the base env /
# CI stays GPU-free.
#
# Pinned to the SAME driver-535-proven base as cellvit: this host is driver 535 (CUDA <= 12.2), so
# a torch 2.7 / cuda 12.6+ image would need driver >= 550 and fail to start here. torch==2.2.2 is
# pinned so no dependency can pull a cu13x wheel. transformers/qwen-vl-utils/accelerate are the
# versions PathAgent validated for Patho-R1; Qwen2.5-VL needs no torch 2.7 and runs on 2.2.2.
FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime

RUN pip install --no-cache-dir \
      "torch==2.2.2" \
      "transformers==4.51.0" "qwen-vl-utils==0.0.14" "accelerate==1.10.0" \
      flask "httpx>=0.27" numpy pillow gunicorn

WORKDIR /app
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8021

# 1 worker: Patho-R1-7B is a warm GPU singleton; extra workers would each reload it. The long
# timeout covers first-request model load + per-region VLM inference.
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8021", "--timeout", "600", \
     "pathvlm_service.app:create_app()"]
