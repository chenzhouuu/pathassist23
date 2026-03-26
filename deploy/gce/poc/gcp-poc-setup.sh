#!/usr/bin/env bash
# =============================================================================
# deploy/gce/poc/gcp-poc-setup.sh
#
# One-command POC setup on Google Cloud
# Run from your LOCAL machine:
#
#   chmod +x deploy/gce/poc/gcp-poc-setup.sh
#   ./deploy/gce/poc/gcp-poc-setup.sh
#
# Prerequisites:
#   - gcloud CLI installed (https://cloud.google.com/sdk/docs/install)
#   - gcloud auth login already done
#   - GCP project set: gcloud config set project YOUR_PROJECT_ID
# =============================================================================
set -euo pipefail

# ── CONFIG — edit these ───────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT:-pathassist-poc}"
REGION="us-east1"
ZONE="us-east1-b"
VM_NAME="pathassist-poc"
MACHINE_TYPE="e2-standard-4"      # 4 vCPU / 16GB RAM (~$60/mo, or ~$12 spot)
DISK_SIZE="100GB"
USE_SPOT="${USE_SPOT:-true}"       # true = ~80% cheaper, can be interrupted
BRAND="${BRAND:-algopath}"         # which brand to deploy for POC

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Validate ──────────────────────────────────────────────────────────────────
command -v gcloud &>/dev/null || error "gcloud CLI not installed. See https://cloud.google.com/sdk/docs/install"
gcloud auth print-access-token &>/dev/null || error "Not logged in. Run: gcloud auth login"

info "==> Using project: $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

# ── Enable APIs ───────────────────────────────────────────────────────────────
info "==> [1/7] Enabling Compute Engine API..."
gcloud services enable compute.googleapis.com --quiet

# ── Reserve Static IP ─────────────────────────────────────────────────────────
info "==> [2/7] Reserving static IP..."
if ! gcloud compute addresses describe pathassist-poc-ip --region="$REGION" &>/dev/null; then
  gcloud compute addresses create pathassist-poc-ip \
    --region="$REGION" \
    --description="PathAssist POC static IP"
fi
POC_IP=$(gcloud compute addresses describe pathassist-poc-ip \
  --region="$REGION" --format='value(address)')
info "    Static IP: $POC_IP"

# ── Firewall Rules ────────────────────────────────────────────────────────────
info "==> [3/7] Creating firewall rules..."
gcloud compute firewall-rules create pathassist-poc-http \
  --allow=tcp:80,tcp:8081 \
  --target-tags=pathassist-poc \
  --source-ranges=0.0.0.0/0 \
  --description="PathAssist POC HTTP" 2>/dev/null || true

gcloud compute firewall-rules create pathassist-poc-ssh \
  --allow=tcp:22 \
  --target-tags=pathassist-poc \
  --source-ranges=0.0.0.0/0 2>/dev/null || true

# ── Create VM ─────────────────────────────────────────────────────────────────
info "==> [4/7] Creating VM ($MACHINE_TYPE)..."

SPOT_FLAG=""
if [[ "$USE_SPOT" == "true" ]]; then
  SPOT_FLAG="--provisioning-model=SPOT --instance-termination-action=STOP"
  warn "Using SPOT instance — Google can stop it anytime. Restart with:"
  warn "  gcloud compute instances start $VM_NAME --zone=$ZONE"
fi

gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size="$DISK_SIZE" \
  --boot-disk-type=pd-ssd \
  --address=pathassist-poc-ip \
  --tags=pathassist-poc \
  $SPOT_FLAG \
  --metadata=startup-script='#!/bin/bash
    apt-get update -y
    apt-get install -y docker.io docker-compose-plugin git fuse
    systemctl enable docker && systemctl start docker
    usermod -aG docker ubuntu
    mkdir -p /tmp/dsa-cache
    chmod 777 /tmp/dsa-cache' \
  --description="PathAssist POC server"

info "    VM created. Waiting 30s for startup script to finish..."
sleep 30

# ── Upload files to VM ────────────────────────────────────────────────────────
info "==> [5/7] Uploading config files..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Create directories on VM
gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- "
  sudo mkdir -p \
    /opt/pathassist-poc/dist \
    /opt/digital_slide_archive/devops/ver5/{assetstore,db,keycloak-db,logs,gunicorn,keycloak-theme}
  sudo chown -R ubuntu:ubuntu \
    /opt/pathassist-poc \
    /opt/digital_slide_archive
"

# Upload docker-compose and nginx config
gcloud compute scp \
  "$SCRIPT_DIR/docker-compose.poc.yml" \
  "$VM_NAME:/opt/digital_slide_archive/devops/ver5/docker-compose.yml" \
  --zone="$ZONE"

gcloud compute scp \
  "$SCRIPT_DIR/nginx-poc.conf" \
  "$VM_NAME:/opt/digital_slide_archive/devops/ver5/nginx-poc.conf" \
  --zone="$ZONE"

# Create .env file on VM
DSA_UID=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- "id -u ubuntu"):$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- "id -g ubuntu")

gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- "
cat > /opt/digital_slide_archive/devops/ver5/.env << EOF
DSA_USER=$DSA_UID
KC_DB_PASSWORD=poc_keycloak_db_pass
KC_ADMIN_USER=admin
KC_ADMIN_PASSWORD=admin
EOF
"

info "    Config files uploaded."

# ── Build UI ──────────────────────────────────────────────────────────────────
info "==> [6/7] Building PathAssist UI (brand: $BRAND)..."

declare -A BRAND_VARS
BRAND_VARS[lymphoma]="Impart DX|/impart-dx-logo.png"
BRAND_VARS[mda]="MDA PathAssist|/mda-logo.png"
BRAND_VARS[algopath]="Algopath|/alogopath-logo.png"

IFS='|' read -r APP_NAME LOGO <<< "${BRAND_VARS[$BRAND]}"

# Clone repo on VM and build
gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- "
  cd /opt/pathassist-poc
  git clone https://github.com/$(git -C $REPO_ROOT remote get-url origin | sed 's|.*github.com/||' | sed 's|\.git.*||').git . 2>/dev/null || git pull
  npm install
  VITE_APP_NAME='$APP_NAME' \
  VITE_LOGO_SRC='$LOGO' \
  VITE_APP_TAGLINE='Digital Pathology POC' \
  npm run build
"

info "    UI built."

# ── Copy DSA config files (provision.yaml, girder.cfg etc.) ──────────────────
# These come from EC2 if migrating, or from repo defaults for fresh start
if [[ -f "$SCRIPT_DIR/../dsa-config/girder.cfg" ]]; then
  gcloud compute scp \
    "$SCRIPT_DIR/../dsa-config/girder.cfg" \
    "$VM_NAME:/opt/digital_slide_archive/devops/ver5/girder.cfg" \
    --zone="$ZONE"
else
  warn "No girder.cfg found — Girder will use defaults. Copy from EC2 if migrating."
fi

# ── Start Services ────────────────────────────────────────────────────────────
info "==> [7/7] Starting all services..."

gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- "
  cd /opt/digital_slide_archive/devops/ver5
  docker compose up -d
  echo 'Waiting for services to start...'
  sleep 30
  docker compose ps
"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  POC DEPLOYMENT COMPLETE"
echo "============================================================"
echo ""
echo "  VM IP:            $POC_IP"
echo "  PathAssist UI:    http://$POC_IP/"
echo "  Girder API:       http://$POC_IP/api/v1/"
echo "  Keycloak Admin:   http://$POC_IP:8081/  (admin / admin)"
echo ""
echo "  SSH:  gcloud compute ssh $VM_NAME --zone=$ZONE"
echo "  Logs: gcloud compute ssh $VM_NAME --zone=$ZONE -- \\"
echo "          'docker compose -f /opt/digital_slide_archive/devops/ver5/docker-compose.yml logs -f'"
echo ""
if [[ "$USE_SPOT" == "true" ]]; then
  echo "  ⚠  SPOT instance — if it stops, restart with:"
  echo "     gcloud compute instances start $VM_NAME --zone=$ZONE"
  echo ""
fi
echo "  TEAR DOWN (delete everything):"
echo "     gcloud compute instances delete $VM_NAME --zone=$ZONE"
echo "     gcloud compute addresses delete pathassist-poc-ip --region=$REGION"
echo "============================================================"
