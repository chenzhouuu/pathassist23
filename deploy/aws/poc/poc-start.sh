#!/usr/bin/env bash
# =============================================================================
# deploy/aws/poc/poc-start.sh
#
# Start the POC spot instance before a demo.
# Run from your LOCAL machine:
#
#   ./deploy/aws/poc/poc-start.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.poc-state"
REGION="us-east-1"
EC2_COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"
SSH_KEY="${HOME}/.ssh/histamics20.pem"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# Load state
[[ ! -f "$STATE_FILE" ]] && echo "ERROR: .poc-state not found. Run aws-poc-setup.sh first." && exit 1
source "$STATE_FILE"

info "==> Starting spot instance: $POC_INSTANCE_ID"
aws ec2 start-instances --instance-ids "$POC_INSTANCE_ID" --region "$REGION" > /dev/null

info "    Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$POC_INSTANCE_ID" --region "$REGION"

# Get new public IP (spot instances get a new IP on restart)
POC_IP=$(aws ec2 describe-instances --instance-ids "$POC_INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
info "    Instance running at: $POC_IP"

# Update state file with new IP
sed -i "s/^POC_IP=.*/POC_IP=$POC_IP/" "$STATE_FILE"

# Update ALB target group with new IP (re-register in case it was deregistered)
info "==> Re-registering with ALB target group..."
aws elbv2 register-targets \
  --region "$REGION" \
  --target-group-arn "$POC_TG_ARN" \
  --targets "Id=$POC_INSTANCE_ID,Port=80" 2>/dev/null || true

# Wait for SSH
info "==> Waiting for SSH (~60s)..."
sleep 30
for i in {1..12}; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "ubuntu@$POC_IP" "echo ok" 2>/dev/null && break
  echo "    Retrying SSH ($i/12)..."
  sleep 10
done

# Start Docker containers
info "==> Starting Docker services..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$POC_IP" "
  cd $EC2_COMPOSE_DIR
  docker compose up -d
  docker compose ps --format 'table {{.Name}}\t{{.Status}}'
"

# Wait for Girder health check
info "==> Waiting for Girder to be healthy..."
for i in {1..24}; do
  CODE=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$POC_IP" \
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/v1/system/version" 2>/dev/null)
  [[ "$CODE" == "200" ]] && info "    Girder healthy ✓" && break
  echo "    Waiting for Girder ($i/24)..."
  sleep 10
done

# Wait for ALB health check to pass
info "==> Waiting for ALB health check (~30s)..."
sleep 30

echo ""
echo "============================================================"
echo "  POC IS READY"
echo "============================================================"
echo ""
echo "  https://poc.impart.pathassist.health/"
echo "  https://poc.mda.pathassist.health/"
echo "  https://poc.algopath.pathassist.health/"
echo ""
echo "  After demo: ./deploy/aws/poc/poc-stop.sh"
echo "============================================================"
