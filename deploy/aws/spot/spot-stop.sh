#!/usr/bin/env bash
# =============================================================================
# deploy/aws/spot/spot-stop.sh
#
# Gracefully stop the spot instance for planned maintenance.
# WARNING: This takes production offline. Use only for maintenance.
#
#   ./deploy/aws/spot/spot-stop.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.spot-state"
REGION="us-east-1"
SSH_KEY="${HOME}/.ssh/histamics20.pem"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }

[[ ! -f "$STATE_FILE" ]] && echo "ERROR: .spot-state not found." && exit 1
source "$STATE_FILE"

echo -e "${YELLOW}WARNING: This stops production traffic. Continue? (yes/no)${NC}"
read -p "> " CONFIRM
[[ "$CONFIRM" != "yes" ]] && echo "Aborted." && exit 0

info "==> Removing from ALB (traffic stops now)..."
aws elbv2 deregister-targets \
  --region "$REGION" \
  --target-group-arn "$PROD_TG_ARN" \
  --targets "Id=$SPOT_INSTANCE_ID,Port=80" 2>/dev/null || true

info "==> Stopping Docker gracefully..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "ubuntu@$SPOT_IP" \
  "cd /opt/digital_slide_archive/devops/ver5 && docker compose stop" 2>/dev/null || true

info "==> Stopping instance..."
aws ec2 stop-instances --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION" > /dev/null
aws ec2 wait instance-stopped --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION"

echo ""
echo "========================================================"
echo "  SPOT INSTANCE STOPPED"
echo "  Data EBS ($SPOT_DATA_VOL_ID) preserved"
echo "  Restart: ./deploy/aws/spot/spot-start.sh"
echo "========================================================"
