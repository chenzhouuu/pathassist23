#!/usr/bin/env bash
# =============================================================================
# deploy/gce/poc/poc-start.sh
#
# Start the POC spot VM and wait until PathAssist is accessible.
# Run this before every demo.
#
#   ./deploy/gce/poc/poc-start.sh
# =============================================================================

VM_NAME="pathassist-poc"
ZONE="us-east1-b"
REGION="us-east1"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }

POC_IP=$(gcloud compute addresses describe pathassist-poc-ip \
  --region="$REGION" --format='value(address)' 2>/dev/null)

# ── Check current state ───────────────────────────────────────────────────────
STATUS=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" --format='value(status)' 2>/dev/null || echo "NOT_FOUND")

if [[ "$STATUS" == "RUNNING" ]]; then
  info "VM is already running."
else
  info "Starting VM..."
  gcloud compute instances start "$VM_NAME" --zone="$ZONE"
  info "VM started. Waiting for boot..."
  sleep 20
fi

# ── Start docker services (in case they stopped with the VM) ─────────────────
info "Starting Docker services..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" -- \
  "cd /opt/digital_slide_archive/devops/ver5 && docker compose up -d" 2>/dev/null

# ── Wait until Girder is healthy ─────────────────────────────────────────────
info "Waiting for Girder to be ready..."
for i in $(seq 1 24); do
  if curl -sf "http://$POC_IP/api/v1/system/version" &>/dev/null; then
    break
  fi
  echo -n "."
  sleep 5
done
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  POC IS READY"
echo "========================================"
echo ""
echo "  PathAssist:   http://$POC_IP/"
echo "  Girder API:   http://$POC_IP/api/v1/"
echo "  Keycloak:     http://$POC_IP:8081/"
echo ""
echo "  Stop after demo: ./deploy/gce/poc/poc-stop.sh"
echo "========================================"
