#!/usr/bin/env bash
# =============================================================================
# deploy/gce/poc/poc-stop.sh
#
# Stop the POC VM after a demo to save cost.
# Spot VMs cost $0 when stopped — only pay for disk storage (~$10/month).
#
#   ./deploy/gce/poc/poc-stop.sh
# =============================================================================

VM_NAME="pathassist-poc"
ZONE="us-east1-b"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }

info "Stopping VM: $VM_NAME..."
gcloud compute instances stop "$VM_NAME" --zone="$ZONE"

echo ""
echo "========================================"
echo "  VM STOPPED — cost reduced to ~\$10/month (disk only)"
echo "  Start again before next demo:"
echo "  ./deploy/gce/poc/poc-start.sh"
echo "========================================"
