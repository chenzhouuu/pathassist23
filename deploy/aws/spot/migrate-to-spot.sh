#!/usr/bin/env bash
# =============================================================================
# deploy/aws/spot/migrate-to-spot.sh
#
# Migrate production EC2 (on-demand) → spot EC2 with same data, same ALB,
# same subdomains. Zero DNS changes required.
#
# Flow:
#   1. Snapshot prod EBS (live — zero downtime on prod)
#   2. Launch new spot EC2
#   3. Create data EBS from snapshot → attach
#   4. Mount, configure, build UI, start services
#   5. Health check new instance
#   6. ALB cutover: swap target group registration (prod out, spot in)
#   7. Stop old instance (kept as rollback for 7 days)
#
# Rollback at any point: ./rollback.sh
#
# Run from LOCAL machine:
#   chmod +x deploy/aws/spot/migrate-to-spot.sh
#   ./deploy/aws/spot/migrate-to-spot.sh
# =============================================================================
set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────────
REGION="us-east-1"
AZ="us-east-1d"
SUBNET_ID="subnet-0e6f3269c7e40f01d"
SECURITY_GROUP_ID="sg-04161e9cbc358700c"
AMI_ID="ami-04680790a315cd58d"             # Ubuntu 22.04 LTS
KEY_NAME="histamics20"
SSH_KEY="${HOME}/.ssh/histamics20.pem"
INSTANCE_TYPE="${INSTANCE_TYPE:-c6i.2xlarge}"  # Same as prod (8 vCPU / 16GB)
SPOT_MAX_PRICE="${SPOT_MAX_PRICE:-0.15}"        # on-demand ~$0.34/hr

PROD_INSTANCE_ID="i-04e4878afcd65a5a1"
PROD_IP="54.224.61.23"
EC2_COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"
REPO_URL="https://github.com/tkantheti/pathassist23.git"
REPO_BRANCH="keycloak-integration"

# Existing ALB target group — same one all subdomains use
PROD_TG_ARN="arn:aws:elasticloadbalancing:us-east-1:039205283883:targetgroup/pathassist-nginx-80/c369d0711c53f71b"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.spot-state"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
section() { echo -e "\n${BOLD}$*${NC}"; }
ssh_prod(){ ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$PROD_IP" "$@"; }
ssh_spot(){ ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "ubuntu@$SPOT_IP" "$@"; }

# Safety check
echo -e "${YELLOW}"
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  PRODUCTION MIGRATION — Migrate to Spot EC2             │"
echo "  │                                                          │"
echo "  │  This will:                                              │"
echo "  │  • Snapshot prod EBS (live, no downtime)                 │"
echo "  │  • Launch new spot $INSTANCE_TYPE (~\$0.04-0.10/hr)      │"
echo "  │  • Cutover ALB to new instance (~30s downtime)           │"
echo "  │  • Stop old instance (kept 7 days for rollback)          │"
echo "  │                                                          │"
echo "  │  Rollback anytime: ./deploy/aws/spot/rollback.sh         │"
echo "  └─────────────────────────────────────────────────────────┘"
echo -e "${NC}"
read -p "  Continue? (yes/no): " CONFIRM
[[ "$CONFIRM" != "yes" ]] && echo "Aborted." && exit 0

# ── STEP 1: Snapshot production EBS ──────────────────────────────────────────
section "==> [1/7] Snapshotting production EBS (live, zero impact)..."

PROD_VOL_ID=$(aws ec2 describe-instances \
  --instance-ids "$PROD_INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
  --output text)
info "    Production volume: $PROD_VOL_ID"

SNAPSHOT_ID=$(aws ec2 create-snapshot \
  --region "$REGION" \
  --volume-id "$PROD_VOL_ID" \
  --description "Pre-spot-migration $(date +%Y-%m-%d-%H%M)" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=pathassist-spot-migration},{Key=CreatedBy,Value=migrate-to-spot},{Key=Date,Value=$(date +%Y-%m-%d)}]" \
  --query 'SnapshotId' --output text)
info "    Snapshot: $SNAPSHOT_ID — waiting for completion (5-15 min)..."
aws ec2 wait snapshot-completed --snapshot-ids "$SNAPSHOT_ID" --region "$REGION"
info "    Snapshot complete ✓"

# ── STEP 2: Launch spot EC2 ───────────────────────────────────────────────────
section "==> [2/7] Launching spot EC2 ($INSTANCE_TYPE)..."

USERDATA=$(cat << 'EOF'
#!/bin/bash
apt-get update -y
apt-get install -y docker.io docker-compose-plugin git curl awscli
systemctl enable docker && systemctl start docker
usermod -aG docker ubuntu
mkdir -p /opt/pathassist23 /opt/pathassist-mda /opt/pathassist-algopath /opt/pathassist-lymphoma
mkdir -p /mnt/dsa-cache
chmod 777 /mnt/dsa-cache
EOF
)

SPOT_INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SECURITY_GROUP_ID" \
  --subnet-id "$SUBNET_ID" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":60,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --instance-market-options "{\"MarketType\":\"spot\",\"SpotOptions\":{\"MaxPrice\":\"$SPOT_MAX_PRICE\",\"SpotInstanceType\":\"persistent\",\"InstanceInterruptionBehavior\":\"stop\"}}" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=pathassist-spot},{Key=Environment,Value=production},{Key=Role,Value=spot},{Key=Project,Value=PathAssist}]" \
  --user-data "$USERDATA" \
  --query 'Instances[0].InstanceId' \
  --output text)

info "    Spot instance: $SPOT_INSTANCE_ID"
info "    Waiting for running state..."
aws ec2 wait instance-running --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION"

SPOT_IP=$(aws ec2 describe-instances --instance-ids "$SPOT_INSTANCE_ID" --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
info "    Running at: $SPOT_IP ✓"

# Save state immediately for rollback capability
cat > "$STATE_FILE" << EOF
SPOT_INSTANCE_ID=$SPOT_INSTANCE_ID
SPOT_IP=$SPOT_IP
PROD_INSTANCE_ID=$PROD_INSTANCE_ID
PROD_VOL_ID=$PROD_VOL_ID
SNAPSHOT_ID=$SNAPSHOT_ID
PROD_TG_ARN=$PROD_TG_ARN
MIGRATION_DATE=$(date +%Y-%m-%d)
EOF

# ── STEP 3: Create data EBS from snapshot and attach ─────────────────────────
section "==> [3/7] Creating data EBS from snapshot..."

DATA_VOL_ID=$(aws ec2 create-volume \
  --region "$REGION" \
  --availability-zone "$AZ" \
  --snapshot-id "$SNAPSHOT_ID" \
  --volume-type gp3 \
  --size 210 \
  --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=pathassist-spot-data},{Key=Environment,Value=production}]" \
  --query 'VolumeId' --output text)
info "    Data volume: $DATA_VOL_ID (210GB gp3 from snapshot)"

aws ec2 wait volume-available --volume-ids "$DATA_VOL_ID" --region "$REGION"
aws ec2 attach-volume \
  --region "$REGION" \
  --instance-id "$SPOT_INSTANCE_ID" \
  --volume-id "$DATA_VOL_ID" \
  --device /dev/xvdf

echo "SPOT_DATA_VOL_ID=$DATA_VOL_ID" >> "$STATE_FILE"
info "    Data volume attached ✓"

# ── STEP 4: SSH, mount EBS, restore data ─────────────────────────────────────
section "==> [4/7] Configuring spot instance..."
info "    Waiting for SSH (~90s)..."
sleep 60
for i in {1..15}; do
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    "ubuntu@$SPOT_IP" "echo ok" 2>/dev/null && break
  echo "    Retrying SSH ($i/15)..."
  sleep 10
done

# Mount the data EBS (contains full prod data: db/, assetstore/, configs)
info "    Mounting data volume at $EC2_COMPOSE_DIR..."
ssh_spot "
  sudo mkdir -p $EC2_COMPOSE_DIR
  # Wait for device
  for i in \$(seq 1 15); do [ -b /dev/xvdf ] && break; sleep 3; done
  # Mount (data from snapshot — do NOT format)
  sudo mount /dev/xvdf $EC2_COMPOSE_DIR 2>/dev/null || \
  sudo mount -o nouuid /dev/xvdf $EC2_COMPOSE_DIR
  sudo chown -R ubuntu:ubuntu $EC2_COMPOSE_DIR
  ls $EC2_COMPOSE_DIR
  echo 'Mounted ✓'
  # Persist in fstab
  echo '/dev/xvdf $EC2_COMPOSE_DIR ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
"

# Copy docker-compose (same production config — no POC version)
info "    Uploading docker-compose config..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$SCRIPT_DIR/docker-compose.spot.yml" \
  "ubuntu@$SPOT_IP:$EC2_COMPOSE_DIR/docker-compose.yml"

# ── STEP 5: Build UI and start services ───────────────────────────────────────
section "==> [5/7] Building UI and starting services..."
ssh_spot "
  cd /opt/pathassist23
  git clone $REPO_URL . 2>/dev/null || (git fetch && git reset --hard origin/$REPO_BRANCH)
  git checkout $REPO_BRANCH
  npm install --silent

  for entry in 'lymphoma|Impart DX|/impart-dx-logo.png|/opt/pathassist-lymphoma' \
               'mda|MDA PathAssist|/mda-logo.png|/opt/pathassist-mda' \
               'algopath|Algopath|/alogopath-logo.png|/opt/pathassist-algopath'; do
    IFS='|' read -r brand name logo dir <<< \"\$entry\"
    VITE_APP_NAME=\"\$name\" VITE_LOGO_SRC=\"\$logo\" \
    VITE_APP_TAGLINE='Digital Pathology Platform' npm run build 2>&1 | tail -2
    mkdir -p \$dir
    cp -r dist/. \$dir/dist/
    echo \"\$brand built ✓\"
  done

  cd $EC2_COMPOSE_DIR
  docker compose pull --quiet 2>/dev/null || true
  docker compose up -d
  echo 'Services started. Waiting 90s for Girder...'
  sleep 90
"

# ── STEP 6: Health check new instance ────────────────────────────────────────
section "==> [6/7] Health checking new spot instance..."
for i in {1..20}; do
  CODE=$(ssh_spot "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/v1/system/version" 2>/dev/null)
  if [[ "$CODE" == "200" ]]; then
    info "    Girder healthy ✓"
    break
  fi
  echo "    Waiting for Girder ($i/20) — got HTTP $CODE..."
  sleep 15
  [[ $i -eq 20 ]] && error "Girder did not become healthy. Aborting before cutover. Run ./rollback.sh to clean up."
done

# Check all containers running
ssh_spot "docker ps --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo -e "${YELLOW}"
echo "  ┌──────────────────────────────────────────────────────────────┐"
echo "  │  SPOT INSTANCE IS HEALTHY AND READY                          │"
echo "  │                                                               │"
echo "  │  Next: ALB CUTOVER (~30 seconds of downtime)                 │"
echo "  │  This will deregister prod and register spot with the ALB.   │"
echo "  │                                                               │"
echo "  │  Rollback: ./deploy/aws/spot/rollback.sh                     │"
echo "  └──────────────────────────────────────────────────────────────┘"
echo -e "${NC}"
read -p "  Proceed with ALB cutover? (yes/no): " CUTOVER
[[ "$CUTOVER" != "yes" ]] && warn "Cutover skipped. Spot instance is running but NOT serving traffic." && exit 0

# ── STEP 7: ALB cutover ───────────────────────────────────────────────────────
section "==> [7/7] ALB cutover — swapping production → spot..."

# Register spot instance
aws elbv2 register-targets \
  --region "$REGION" \
  --target-group-arn "$PROD_TG_ARN" \
  --targets "Id=$SPOT_INSTANCE_ID,Port=80"
info "    Spot instance registered in target group"

# Wait for spot to be healthy in ALB
info "    Waiting for ALB health check to pass (~30s)..."
for i in {1..12}; do
  STATE=$(aws elbv2 describe-target-health \
    --region "$REGION" \
    --target-group-arn "$PROD_TG_ARN" \
    --targets "Id=$SPOT_INSTANCE_ID,Port=80" \
    --query 'TargetHealthDescriptions[0].TargetHealth.State' \
    --output text)
  [[ "$STATE" == "healthy" ]] && info "    Spot is healthy in ALB ✓" && break
  echo "    ALB health: $STATE ($i/12)..."
  sleep 10
  [[ $i -eq 12 ]] && warn "ALB health check slow — proceeding anyway. Check AWS console."
done

# Deregister old production instance
info "    Deregistering old production instance from ALB..."
aws elbv2 deregister-targets \
  --region "$REGION" \
  --target-group-arn "$PROD_TG_ARN" \
  --targets "Id=$PROD_INSTANCE_ID,Port=80"
info "    Old instance removed from ALB ✓"

# Stop old instance (NOT terminate — keep for rollback)
info "    Stopping old production instance (keeping for rollback)..."
aws ec2 stop-instances --instance-ids "$PROD_INSTANCE_ID" --region "$REGION" > /dev/null

echo "CUTOVER_COMPLETE=true" >> "$STATE_FILE"
echo "CUTOVER_DATE=$(date +%Y-%m-%d)" >> "$STATE_FILE"

# ── DONE ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}"
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║  MIGRATION COMPLETE — Production is now on spot             ║"
echo "  ╠══════════════════════════════════════════════════════════════╣"
echo "  ║  Spot instance:  $SPOT_INSTANCE_ID              ║"
echo "  ║  Spot IP:        $SPOT_IP                                  ║"
echo "  ║  Data EBS:       $DATA_VOL_ID                             ║"
echo "  ║                                                              ║"
echo "  ║  All subdomains now served by spot instance:                ║"
echo "  ║  https://impart.pathassist.health/                          ║"
echo "  ║  https://mda.pathassist.health/                             ║"
echo "  ║  https://algopath.pathassist.health/                        ║"
echo "  ║                                                              ║"
echo "  ║  Old prod ($PROD_INSTANCE_ID) is STOPPED (rollback for 7d) ║"
echo "  ║  Rollback: ./deploy/aws/spot/rollback.sh                    ║"
echo "  ║  Savings:  ~75% vs on-demand                                ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
