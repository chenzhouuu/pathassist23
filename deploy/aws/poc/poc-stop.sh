#!/usr/bin/env bash
# =============================================================================
# deploy/aws/poc/poc-stop.sh
#
# Stop the POC spot instance after a demo to save cost.
# Stopped spot instances: ~$1.20/month (EBS only, no compute cost).
#
#   ./deploy/aws/poc/poc-stop.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.poc-state"
REGION="us-east-1"
SSH_KEY="${HOME}/.ssh/histamics20.pem"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }

[[ ! -f "$STATE_FILE" ]] && echo "ERROR: .poc-state not found. Run aws-poc-setup.sh first." && exit 1
source "$STATE_FILE"

# Gracefully stop Docker before instance stop
info "==> Stopping Docker services on $POC_IP..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "ubuntu@$POC_IP" \
  "cd /opt/digital_slide_archive/devops/ver5 && docker compose stop" 2>/dev/null || \
  warn "Could not connect to stop Docker gracefully — stopping instance anyway"

info "==> Stopping spot instance: $POC_INSTANCE_ID..."
aws ec2 stop-instances --instance-ids "$POC_INSTANCE_ID" --region "$REGION" > /dev/null
aws ec2 wait instance-stopped --instance-ids "$POC_INSTANCE_ID" --region "$REGION"

echo ""
echo "========================================================"
echo "  POC STOPPED"
echo "========================================================"
echo "  Data EBS ($POC_DATA_VOL_ID) is safe — data preserved"
echo "  Cost: ~\$1.20/month (EBS storage only)"
echo ""
echo "  Start again: ./deploy/aws/poc/poc-start.sh"
echo "========================================================"
