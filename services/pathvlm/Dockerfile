# services/pathvlm/Dockerfile — pathology VLM service (GPU, Flask).
#
# Hosts the Perceptor (Patho-R1-7B, a Qwen2.5-VL pathology model) now and the Navigator (PLIP)
# later, in-process behind the infer.describe_array stub seam with a warm singleton.
# torch/transformers live only here and are imported lazily on the real path, so the base env /
# CI stays GPU-free. The exact base-image / torch tag is finalized when the real model lands
# (Inc 2a T6) against the deployment's NVIDIA driver.
FROM pytorch/pytorch:2.7.0-cuda12.1-cudnn9-runtime

# Patho-R1 is Qwen2.5-VL → transformers>=4.51 + qwen-vl-utils (per the PathAgent requirements).
RUN pip install --no-cache-dir \
      "transformers>=4.51" "accelerate>=1.0" qwen-vl-utils \
      flask "httpx>=0.27" numpy pillow gunicorn

WORKDIR /app
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8021

# 1 worker: Patho-R1-7B is a warm GPU singleton; extra workers would each reload it. The long
# timeout covers first-request model load + per-region VLM inference.
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:8021", "--timeout", "600", \
     "pathvlm_service.app:create_app()"]
