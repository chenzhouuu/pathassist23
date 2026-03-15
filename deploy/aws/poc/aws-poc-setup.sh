#!/usr/bin/env bash
# =============================================================================
# deploy/aws/poc/aws-poc-setup.sh
#
# One-command AWS POC setup — creates a spot EC2 instance, attaches a data
# EBS volume (fresh OR cloned from production snapshot), registers with the
# existing ALB, and deploys all 3 PathAssist brands.
#
# Run from your LOCAL machine:
#   chmod +x deploy/aws/poc/aws-poc-setup.sh
#   ./deploy/aws/poc/aws-poc-setup.sh           # fresh data
#   ./deploy/aws/poc/aws-poc-setup.sh --from-prod  # clone prod data
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - SSH key: ~/.ssh/histamics20.pem
#   - Existing ALB + production EC2 must be running
# =============================================================================
set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────────
REGION="us-east-1"
AZ="us-east-1d"
VPC_ID="vpc-00a652c770aa3e3c7"
SUBNET_ID="subnet-0e6f3269c7e40f01d"
SECURITY_GROUP_ID="sg-04161e9cbc358700c"
AMI_ID="ami-04680790a315cd58d"           # Ubuntu 22.04 LTS
KEY_NAME="histamics20"
SSH_KEY="${HOME}/.ssh/histamics20.pem"
INSTANCE_TYPE="${INSTANCE_TYPE:-m5.xlarge}"  # 4 vCPU / 16 GB
SPOT_MAX_PRICE="0.08"                    # on-demand ~$0.192/hr

EC2_PROD_ID="i-04e4878afcd65a5a1"        # existing production instance
EC2_COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"
REPO_URL="https://github.com/tkantheti/pathassist23.git"
REPO_BRANCH="keycloak-integration"

ALB_ARN="arn:aws:elasticloadbalancing:us-east-1:039205283883:loadbalancer/app/dsa/84314737a7703d71"
HTTPS_LISTENER_ARN="arn:aws:elasticloadbalancing:us-east-1:039205283883:listener/app/dsa/84314737a7703d71/f43fa4c032b77088"
ACM_CERT_ARN="arn:aws:acm:us-east-1:039205283883:certificate/6d2f55db-2001-49cc-bdcd-cc8e582e4bf1"

# POC subdomains (all under pathassist.health — add GoDaddy CNAMEs pointing to ALB)
POC_DOMAINS=("poc.impart.pathassist.health" "poc.mda.pathassist.health" "poc.algopath.pathassist.health" "poc.auth.pathassist.health")

# ── HELPERS ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
ssh_cmd() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$POC_IP" "$@"; }

MODE="${1:---fresh}"
[[ "$MODE" != "--fresh" && "$MODE" != "--from-prod" ]] && \
  error "Usage: $0 [--fresh|--from-prod]"

info "==> Mode: $MODE"
info "==> Instance type: $INSTANCE_TYPE (spot, max \$$SPOT_MAX_PRICE/hr)"

# ── STEP 1: Snapshot prod EBS (if --from-prod) ────────────────────────────────
SNAPSHOT_ID=""
if [[ "$MODE" == "--from-prod" ]]; then
  info "==> [1/8] Creating EBS snapshot from production (this takes 5-15 min)..."
  PROD_VOL_ID=$(aws ec2 describe-instances --instance-ids "$EC2_PROD_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
    --output text)
  info "    Production volume: $PROD_VOL_ID"

  SNAPSHOT_ID=$(aws ec2 create-snapshot \
    --region "$REGION" \
    --volume-id "$PROD_VOL_ID" \
    --description "PathAssist POC $(date +%Y-%m-%d)" \
    --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=pathassist-poc-snapshot},{Key=Environment,Value=poc}]' \
    --query 'SnapshotId' --output text)
  info "    Snapshot ID: $SNAPSHOT_ID — waiting for completion..."
  aws ec2 wait snapshot-completed --snapshot-ids "$SNAPSHOT_ID" --region "$REGION"
  info "    Snapshot ready ✓"
else
  info "==> [1/8] Skipping snapshot (fresh mode)"
fi

# ── STEP 2: Launch spot EC2 ───────────────────────────────────────────────────
info "==> [2/8] Launching spot EC2 ($INSTANCE_TYPE)..."

USERDATA=$(cat << 'USERDATA_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y docker.io docker-compose-plugin git awscli curl
systemctl enable docker && systemctl start docker
usermod -aG docker ubuntu
mkdir -p /opt/digital_slide_archive/devops/ver5/{assetstore,db,keycloak-db,logs,gunicorn,keycloak-theme}
mkdir -p /opt/pathassist-poc /opt/pathassist-mda /opt/pathassist-algopath /opt/pathassist-lymphoma
mkdir -p /mnt/dsa-cache
chmod 777 /mnt/dsa-cache
USERDATA_EOF
)

INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SECURITY_GROUP_ID" \
  --subnet-id "$SUBNET_ID" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":60,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --instance-market-options "{\"MarketType\":\"spot\",\"SpotOptions\":{\"MaxPrice\":\"$SPOT_MAX_PRICE\",\"SpotInstanceType\":\"persistent\",\"InstanceInterruptionBehavior\":\"stop\"}}" \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=pathassist-poc},{Key=Environment,Value=poc},{Key=Project,Value=PathAssist}]' \
  --user-data "$USERDATA" \
  --query 'Instances[0].InstanceId' \
  --output text)

info "    Instance ID: $INSTANCE_ID"
info "    Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

POC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
info "    Running at: $POC_IP ✓"

# ── STEP 3: Create and attach data EBS ───────────────────────────────────────
info "==> [3/8] Creating data EBS volume..."

if [[ "$MODE" == "--from-prod" ]]; then
  DATA_SIZE=210  # Slightly larger than prod snapshot (200GB)
  DATA_VOL_ID=$(aws ec2 create-volume \
    --region "$REGION" \
    --availability-zone "$AZ" \
    --snapshot-id "$SNAPSHOT_ID" \
    --volume-type gp3 \
    --size "$DATA_SIZE" \
    --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=pathassist-poc-data},{Key=Environment,Value=poc}]' \
    --query 'VolumeId' --output text)
  info "    Data volume from snapshot: $DATA_VOL_ID (${DATA_SIZE}GB)"
else
  DATA_VOL_ID=$(aws ec2 create-volume \
    --region "$REGION" \
    --availability-zone "$AZ" \
    --volume-type gp3 \
    --size 100 \
    --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=pathassist-poc-data},{Key=Environment,Value=poc}]' \
    --query 'VolumeId' --output text)
  info "    Fresh data volume: $DATA_VOL_ID (100GB)"
fi

aws ec2 wait volume-available --volume-ids "$DATA_VOL_ID" --region "$REGION"

aws ec2 attach-volume \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --volume-id "$DATA_VOL_ID" \
  --device /dev/xvdf

info "    Data volume attached ✓"

# Save instance details for start/stop scripts
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat > "$SCRIPT_DIR/.poc-state" << EOF
POC_INSTANCE_ID=$INSTANCE_ID
POC_DATA_VOL_ID=$DATA_VOL_ID
POC_IP=$POC_IP
EOF
info "    State saved to .poc-state"

# ── STEP 4: Wait for SSH + mount data volume ──────────────────────────────────
info "==> [4/8] Waiting for SSH to become available (~60s)..."
sleep 60
for i in {1..12}; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "ubuntu@$POC_IP" "echo ok" 2>/dev/null && break
  echo "    Retrying SSH ($i/12)..."
  sleep 10
done

info "    SSH ready. Mounting data volume..."

ssh_cmd "
  # Wait for EBS device to appear
  for i in \$(seq 1 10); do
    [ -b /dev/xvdf ] && break
    sleep 5
  done

  if [[ '$MODE' == '--from-prod' ]]; then
    # Mount without formatting (data from snapshot)
    sudo mkdir -p $EC2_COMPOSE_DIR
    # Mount at compose dir — contains db/, assetstore/, etc. from prod
    echo '/dev/xvdf $EC2_COMPOSE_DIR ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
    sudo mount /dev/xvdf $EC2_COMPOSE_DIR || sudo mount -o nouuid /dev/xvdf $EC2_COMPOSE_DIR
    sudo chown -R ubuntu:ubuntu $EC2_COMPOSE_DIR
  else
    # Fresh — format and mount
    sudo mkfs.ext4 /dev/xvdf
    sudo mkdir -p $EC2_COMPOSE_DIR
    echo '/dev/xvdf $EC2_COMPOSE_DIR ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
    sudo mount /dev/xvdf $EC2_COMPOSE_DIR
    sudo mkdir -p $EC2_COMPOSE_DIR/{assetstore,db,keycloak-db,logs,gunicorn,keycloak-theme}
    sudo chown -R ubuntu:ubuntu $EC2_COMPOSE_DIR
  fi
  echo 'Data volume mounted ✓'
"

# ── STEP 5: Upload configs and build UI ───────────────────────────────────────
info "==> [5/8] Uploading docker-compose and nginx configs..."

scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$SCRIPT_DIR/docker-compose.poc.yml" \
  "ubuntu@$POC_IP:$EC2_COMPOSE_DIR/docker-compose.yml"

scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$SCRIPT_DIR/nginx-poc.conf" \
  "ubuntu@$POC_IP:$EC2_COMPOSE_DIR/nginx-poc.conf"

# Copy .env from production (has KC passwords)
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no ubuntu@54.224.61.23 \
  "cat $EC2_COMPOSE_DIR/.env" | \
  ssh_cmd "cat > $EC2_COMPOSE_DIR/.env"

# Copy girder.cfg, provision.yaml from production
for f in girder.cfg provision.yaml provision.py rabbitmq.advanced.config; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no ubuntu@54.224.61.23 \
    "cat $EC2_COMPOSE_DIR/$f 2>/dev/null || echo ''" | \
    ssh_cmd "cat > $EC2_COMPOSE_DIR/$f" 2>/dev/null || true
done

info "    Configs uploaded ✓"

info "==> [6/8] Building PathAssist UI (all 3 brands)..."
ssh_cmd "
  cd /opt/pathassist-poc
  git clone $REPO_URL . 2>/dev/null || git pull
  git checkout $REPO_BRANCH
  npm install --silent

  for brand in lymphoma mda algopath; do
    case \$brand in
      lymphoma) NAME='Impart DX'; LOGO='/impart-dx-logo.png'; DIR='/opt/pathassist-lymphoma' ;;
      mda)      NAME='MDA PathAssist'; LOGO='/mda-logo.png'; DIR='/opt/pathassist-mda' ;;
      algopath) NAME='Algopath'; LOGO='/alogopath-logo.png'; DIR='/opt/pathassist-algopath' ;;
    esac
    VITE_APP_NAME=\"\$NAME\" VITE_LOGO_SRC=\"\$LOGO\" VITE_APP_TAGLINE='Digital Pathology POC' npm run build 2>&1 | tail -2
    mkdir -p \$DIR
    cp -r dist/. \$DIR/dist/
    echo \"\$brand built ✓\"
  done
"

# ── STEP 6: Start services ────────────────────────────────────────────────────
info "==> [7/8] Starting Docker services..."
ssh_cmd "
  cd $EC2_COMPOSE_DIR
  docker compose up -d
  echo 'Waiting 60s for services to initialize...'
  sleep 60
  docker compose ps
"

# ── STEP 7: Register with ALB ─────────────────────────────────────────────────
info "==> [8/8] Setting up ALB target group and rules..."

# Create new target group for POC
POC_TG_ARN=$(aws elbv2 create-target-group \
  --region "$REGION" \
  --name "pathassist-poc-nginx-80" \
  --protocol HTTP \
  --port 80 \
  --vpc-id "$VPC_ID" \
  --health-check-path "/" \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text 2>/dev/null || \
  aws elbv2 describe-target-groups --region "$REGION" --names "pathassist-poc-nginx-80" \
    --query 'TargetGroups[0].TargetGroupArn' --output text)

info "    Target group: $POC_TG_ARN"

# Register spot instance with target group
aws elbv2 register-targets \
  --region "$REGION" \
  --target-group-arn "$POC_TG_ARN" \
  --targets "Id=$INSTANCE_ID,Port=80"
info "    Instance registered in target group ✓"

# Add ALB HTTPS rules for poc.* domains (priority 20-23)
PRIORITY=20
for DOMAIN in "${POC_DOMAINS[@]}"; do
  aws elbv2 create-rule \
    --region "$REGION" \
    --listener-arn "$HTTPS_LISTENER_ARN" \
    --priority $PRIORITY \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"$DOMAIN\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$POC_TG_ARN\"}]" \
    --query 'Rules[0].RuleArn' --output text 2>/dev/null || \
    warn "Rule for $DOMAIN already exists or failed — skipping"
  PRIORITY=$((PRIORITY + 1))
done
info "    ALB rules added ✓"

# Save target group ARN to state file
echo "POC_TG_ARN=$POC_TG_ARN" >> "$SCRIPT_DIR/.poc-state"

# ── DONE ──────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  AWS POC READY"
echo "============================================================"
echo ""
echo "  Instance:   $INSTANCE_ID ($POC_IP)"
echo "  Data EBS:   $DATA_VOL_ID"
echo "  Mode:       $MODE"
echo ""
echo "  Add these CNAMEs in GoDaddy → pathassist.health:"
echo "  (all pointing to: dsa-998249893.us-east-1.elb.amazonaws.com)"
echo ""
for DOMAIN in "${POC_DOMAINS[@]}"; do
  NAME="${DOMAIN%.pathassist.health}"
  echo "  CNAME  $NAME  →  dsa-998249893.us-east-1.elb.amazonaws.com"
done
echo ""
echo "  Then access:"
echo "  https://poc.impart.pathassist.health/"
echo "  https://poc.mda.pathassist.health/"
echo "  https://poc.algopath.pathassist.health/"
echo ""
echo "  Stop VM:  ./deploy/aws/poc/poc-stop.sh"
echo "  Start VM: ./deploy/aws/poc/poc-start.sh"
echo "============================================================"
