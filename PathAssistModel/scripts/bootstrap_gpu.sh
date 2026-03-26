#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y \
  python3 python3-venv python3-pip \
  build-essential git curl unzip \
  libgl1 libglib2.0-0 libopenslide0 openslide-tools \
  libvips42 libvips-tools default-jre

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA drivers not found. Install the AWS/NVIDIA GPU driver before running inference."
fi

python3 -m venv /opt/pathassist-model/venv
source /opt/pathassist-model/venv/bin/activate
pip install --upgrade pip wheel

cd /opt/pathassist-model
pip install -r requirements.txt

cat <<'EOF'
Bootstrap complete.
Activate the environment with:
  source /opt/pathassist-model/venv/bin/activate
EOF
