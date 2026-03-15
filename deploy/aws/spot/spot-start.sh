#!/usr/bin/env bash
# =============================================================================
# deploy/aws/spot/spot-start.sh
#
# Start the spot instance after it was stopped (maintenance / AWS preemption).
# Re-registers with ALB and restarts Docker services.
#
#   ./deploy/aws/spot/spot-start.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.spot-state"
REGION="us-east-1"
EC2_COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"
SSH_KEY="${HOME}/.ssh/histamics20.pem"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }

[[ ! -f "$STATE_FILE" ]] && echo "ERROR: .spot-state not found." && exit 1
source "$STATE_FILE"

info "==> Starting spot instance: $SPOT_INSTANCE_ID"
aws ec2 start-instances --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION" > /dev/null
aws ec2 wait instance-running --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION"

SPOT_IP=$(aws ec2 describe-instances --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
sed -i "s/^SPOT_IP=.*/SPOT_IP=$SPOT_IP/" "$STATE_FILE"
info "    Running at: $SPOT_IP"

# Re-register with ALB
info "==> Re-registering with ALB target group..."
aws elbv2 register-targets \
  --region "$REGION" \
  --target-group-arn "$PROD_TG_ARN" \
  --targets "Id=$SPOT_INSTANCE_ID,Port=80"

# Wait for SSH
info "==> Waiting for SSH (~60s)..."
sleep 40
for i in {1..12}; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    "ubuntu@$SPOT_IP" "echo ok" 2>/dev/null && break
  echo "    Retrying ($i/12)..."
  sleep 10
done

# Start Docker
info "==> Starting Docker services..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$SPOT_IP" "
  # Ensure data EBS is mounted
  mountpoint -q $EC2_COMPOSE_DIR || sudo mount /dev/xvdf $EC2_COMPOSE_DIR
  cd $EC2_COMPOSE_DIR
  docker compose up -d
  docker compose ps --format 'table {{.Names}}\t{{.Status}}'
"

# Wait for Girder
info "==> Waiting for Girder..."
for i in {1..24}; do
  CODE=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$SPOT_IP" \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/v1/system/version" 2>/dev/null)
  [[ "$CODE" == "200" ]] && info "    Girder healthy ✓" && break
  echo "    Waiting ($i/24)..."
  sleep 10
done

echo ""
echo "========================================================"
echo "  SPOT INSTANCE RUNNING"
echo "  https://impart.pathassist.health/"
echo "  https://mda.pathassist.health/"
echo "  https://algopath.pathassist.health/"
echo "========================================================"
