# PathAssistModel

Production-oriented WSI AI inference service for Girder/DSA using TIAToolbox HoVer-Net.

## Architecture

Girder (S3 assetstore) -> PathAssistModel FastAPI/Celery -> TIAToolbox HoVer-Net -> Girder annotations -> HistomicsUI

## Features

- Authenticates to Girder using API key, token, or username/password
- Downloads WSIs from Girder item/file endpoints
- Runs HoVer-Net nuclei instance segmentation with TIAToolbox
- Converts nuclei contours to Girder annotation documents
- Uploads summary artifacts to S3
- Supports async execution through Celery workers
- Includes AWS spot/GPU bootstrap scripts

## Project Layout

```text
PathAssistModel/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── girder_service.py
│   ├── inference_service.py
│   ├── annotation_service.py
│   ├── aws_service.py
│   └── utils.py
├── worker/
│   ├── celery_worker.py
│   └── tasks.py
├── scripts/
│   ├── launch_spot_instance.sh
│   └── bootstrap_gpu.sh
├── requirements.txt
├── Dockerfile
└── README.md
```

## Environment Variables

```bash
export PATHASSIST_GIRDER_API_URL="https://gd.pathassist.health/api/v1"
export PATHASSIST_GIRDER_API_KEY="..."
# or PATHASSIST_GIRDER_TOKEN / username+password

export PATHASSIST_CELERY_BROKER_URL="redis://redis:6379/0"
export PATHASSIST_CELERY_RESULT_BACKEND="redis://redis:6379/1"

export PATHASSIST_AWS_REGION="us-east-1"
export PATHASSIST_S3_BUCKET="your-bucket-name"
export PATHASSIST_S3_PREFIX="pathassist-ai"

export PATHASSIST_MODEL_NAME="hovernet_fast-pannuke"
export PATHASSIST_GPU_DEVICE="cuda"
```

## Local Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8081
```

Start a worker separately:

```bash
celery -A worker.celery_worker.celery_app worker --loglevel=INFO --concurrency=1
```

## API

### Health

```bash
curl http://localhost:8081/healthz
```

### Submit HoVer-Net job

```bash
curl -X POST http://localhost:8081/v1/jobs/hovernet \
  -H "Content-Type: application/json" \
  -d '{"item_id":"69b276fb1574683841971679"}'
```

### Poll job

```bash
curl http://localhost:8081/v1/jobs/<task_id>
```

### Synchronous test

```bash
curl -X POST http://localhost:8081/v1/jobs/hovernet \
  -H "Content-Type: application/json" \
  -d '{"item_id":"69b276fb1574683841971679","sync":true}'
```

## Girder Annotation Output

Each HoVer-Net instance contour is converted into a Girder `polyline` annotation element with:

- `closed: true`
- `group: ai-hovernet:<cell-type>`
- `label.value: <cell-type>`
- line/fill color by nucleus type

Large result sets are chunked into multiple annotations to avoid oversized documents.

## TIAToolbox Notes

This project uses the documented `NucleusInstanceSegmentor` WSI flow from TIAToolbox. Current official references:

- TIAToolbox repository: https://github.com/TissueImageAnalytics/tiatoolbox
- Nucleus instance segmentation notebook: https://tia-toolbox.readthedocs.io/en/stable/_notebooks/jnb/08-nucleus-instance-segmentation.html
- NucleusInstanceSegmentor API: https://tia-toolbox.readthedocs.io/en/latest/_modules/tiatoolbox/models/engine/nucleus_instance_segmentor.html

The worker uses a compatibility wrapper because TIAToolbox 1.x and 2.x expose slightly different inference methods.

## AWS Spot Usage

Launch a GPU spot instance:

```bash
cd scripts
AWS_REGION=us-east-1 \
AMI_ID=ami-xxxxxxxx \
SUBNET_ID=subnet-xxxxxxxx \
SECURITY_GROUP_ID=sg-xxxxxxxx \
BOOTSTRAP_URL=https://example.com/bootstrap_gpu.sh \
./launch_spot_instance.sh
```

Bootstrap an existing GPU node:

```bash
./bootstrap_gpu.sh
```

## Production Recommendations

- Use Redis with persistence for Celery broker/backend
- Mount `/tmp/pathassist-model` to fast local NVMe storage if available
- Keep one worker process per GPU unless benchmarking supports more
- Standardize WSI formats to proper pyramidal TIFF/SVS before inference
- Send Girder item IDs from your orchestration layer rather than exposing file paths
- Add Prometheus/Grafana metrics and structured logging before clinical production

## Assumptions

- DSA/Girder is already deployed and reachable
- Girder credentials are available to the service
- The GPU node has enough VRAM for HoVer-Net (`g5.xlarge` or larger recommended)
- Redis is available for Celery
- WSI files are readable by TIAToolbox/OpenSlide
