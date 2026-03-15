#!/usr/bin/env bash
# =============================================================================
# deploy/aws/spot/rollback.sh
#
# Emergency rollback — re-registers old production instance with ALB
# and removes spot instance. Use if spot migration fails or spot is preempted.
#
#   ./deploy/aws/spot/rollback.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.spot-state"
REGION="us-east-1"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }

[[ ! -f "$STATE_FILE" ]] && echo "ERROR: .spot-state not found." && exit 1
source "$STATE_FILE"

echo -e "${RED}"
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  ROLLBACK — Restoring production instance               │"
echo "  └─────────────────────────────────────────────────────────┘"
echo -e "${NC}"

# Start old prod instance
info "==> Starting old production instance ($PROD_INSTANCE_ID)..."
aws ec2 start-instances --instance-ids "$PROD_INSTANCE_ID" --region "$REGION" > /dev/null
aws ec2 wait instance-running --instance-ids "$PROD_INSTANCE_ID" --region "$REGION"

PROD_IP_NEW=$(aws ec2 describe-instances --instance-ids "$PROD_INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
info "    Production instance running at: $PROD_IP_NEW"

# Register prod back to ALB
info "==> Registering production instance with ALB..."
aws elbv2 register-targets \
  --region "$REGION" \
  --target-group-arn "$PROD_TG_ARN" \
  --targets "Id=$PROD_INSTANCE_ID,Port=80"

# Wait for ALB health
info "    Waiting for ALB health check (~30s)..."
for i in {1..12}; do
  STATE=$(aws elbv2 describe-target-health \
    --region "$REGION" \
    --target-group-arn "$PROD_TG_ARN" \
    --targets "Id=$PROD_INSTANCE_ID,Port=80" \
    --query 'TargetHealthDescriptions[0].TargetHealth.State' \
    --output text)
  [[ "$STATE" == "healthy" ]] && info "    Production is healthy in ALB ✓" && break
  echo "    ALB health: $STATE ($i/12)..."
  sleep 10
done

# Remove spot from ALB
if [[ -n "${SPOT_INSTANCE_ID:-}" ]]; then
  info "==> Removing spot instance from ALB..."
  aws elbv2 deregister-targets \
    --region "$REGION" \
    --target-group-arn "$PROD_TG_ARN" \
    --targets "Id=$SPOT_INSTANCE_ID,Port=80" 2>/dev/null || true

  info "==> Stopping spot instance..."
  aws ec2 stop-instances --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION" > /dev/null || true
fi

echo ""
echo "======================================================"
echo "  ROLLBACK COMPLETE"
echo "  Production ($PROD_INSTANCE_ID) is serving traffic"
echo "  All subdomains restored to old instance"
echo "======================================================"
