#!/usr/bin/env bash
# =============================================================================
# deploy/backup-weekly.sh
#
# Weekly backup of all critical PathAssist data to S3.
# Run this on the EC2 instance via cron every Sunday at 2am:
#
#   crontab -e
#   0 2 * * 0 /opt/digital_slide_archive/deploy/backup-weekly.sh >> /var/log/pathassist-backup.log 2>&1
#
# What gets backed up:
#   1. MongoDB (girder DB)       → S3: pathassist-backups/mongodb/
#   2. docker-compose configs    → S3: pathassist-backups/configs/
#   3. girder.cfg, provision.yml → S3: pathassist-backups/configs/
#   4. Nginx config              → S3: pathassist-backups/configs/
#   5. EBS snapshot (weekly)     → AWS Snapshot of root volume
#
# What does NOT need backup (already safe):
#   - Slide images (OME-TIFF)   → already on S3 assetstore (algopathp-pathssist-health)
#   - UI builds (dist/)          → rebuilt from git
#   - Docker images              → rebuilt from Dockerfile (dsa5.Dockerfile in git)
#   - memcached                  → ephemeral tile cache, auto-rebuilds
# =============================================================================
set -euo pipefail

BACKUP_BUCKET="pathassist-backups"
COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"
TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
WEEK=$(date -u +%Y-W%V)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[$(date -u +%H:%M:%S)] INFO${NC}  $*"; }
warn()  { echo -e "${YELLOW}[$(date -u +%H:%M:%S)] WARN${NC}  $*"; }
error() { echo -e "${RED}[$(date -u +%H:%M:%S)] ERROR${NC} $*"; exit 1; }

# ── 1. MongoDB backup ─────────────────────────────────────────────────────────
info "=== [1/4] Backing up MongoDB ==="

MONGO_DUMP_DIR="/tmp/mongodump_${TIMESTAMP}"
mkdir -p "$MONGO_DUMP_DIR"

# Run mongodump inside the container, copy out, upload
docker exec ver5-mongodb-1 mongodump \
    --db girder \
    --out /tmp/mongodump_export \
    --quiet

docker cp ver5-mongodb-1:/tmp/mongodump_export "$MONGO_DUMP_DIR/dump"

# Tar and compress
MONGO_ARCHIVE="/tmp/mongodb_girder_${TIMESTAMP}.tar.gz"
tar -czf "$MONGO_ARCHIVE" -C "$MONGO_DUMP_DIR" dump

MONGO_SIZE=$(du -sh "$MONGO_ARCHIVE" | cut -f1)
info "MongoDB dump size: $MONGO_SIZE"

aws s3 cp "$MONGO_ARCHIVE" \
    "s3://${BACKUP_BUCKET}/mongodb/${WEEK}/mongodb_girder_${TIMESTAMP}.tar.gz" \
    --storage-class STANDARD_IA
info "MongoDB uploaded to s3://${BACKUP_BUCKET}/mongodb/${WEEK}/ ✓"

# Cleanup inside container
docker exec ver5-mongodb-1 rm -rf /tmp/mongodump_export
rm -rf "$MONGO_DUMP_DIR" "$MONGO_ARCHIVE"

# ── 2. Config files backup ───────────────────────────────────────────────────
info "=== [2/4] Backing up config files ==="

CONFIG_ARCHIVE="/tmp/pathassist_configs_${TIMESTAMP}.tar.gz"

tar -czf "$CONFIG_ARCHIVE" \
    -C /opt/digital_slide_archive/devops/ver5 \
    docker-compose.yml \
    girder.cfg \
    provision.yaml \
    provision.py \
    nginx-multi.conf \
    start_girder.sh \
    start_worker.sh 2>/dev/null || true

aws s3 cp "$CONFIG_ARCHIVE" \
    "s3://${BACKUP_BUCKET}/configs/${WEEK}/configs_${TIMESTAMP}.tar.gz" \
    --storage-class STANDARD_IA
info "Configs uploaded to s3://${BACKUP_BUCKET}/configs/${WEEK}/ ✓"
rm -f "$CONFIG_ARCHIVE"

# ── 3. Also backup the Dockerfile (source of truth for image) ────────────────
info "=== [3/4] Backing up Dockerfile ==="

aws s3 cp /opt/digital_slide_archive/dsa5.Dockerfile \
    "s3://${BACKUP_BUCKET}/configs/${WEEK}/dsa5.Dockerfile" \
    --storage-class STANDARD_IA
info "Dockerfile backed up ✓"

# ── 4. EBS Snapshot ──────────────────────────────────────────────────────────
info "=== [4/4] Creating EBS snapshot ==="

INSTANCE_ID=$(curl -sf http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -sf http://169.254.169.254/latest/meta-data/placement/region)

# Get the root volume
ROOT_VOLUME=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/sda1'].Ebs.VolumeId" \
    --output text)

SNAPSHOT_ID=$(aws ec2 create-snapshot \
    --volume-id "$ROOT_VOLUME" \
    --region "$REGION" \
    --description "PathAssist weekly backup ${WEEK}" \
    --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=pathassist-weekly-${WEEK}},{Key=Project,Value=PathAssist},{Key=Retention,Value=4weeks}]" \
    --query 'SnapshotId' \
    --output text)

info "EBS snapshot started: $SNAPSHOT_ID (will complete in ~10-20 min) ✓"

# Delete snapshots older than 4 weeks
info "Cleaning old snapshots (> 4 weeks)..."
OLD_SNAPS=$(aws ec2 describe-snapshots \
    --owner-ids self \
    --region "$REGION" \
    --filters "Name=tag:Project,Values=PathAssist" "Name=tag:Retention,Values=4weeks" \
    --query "Snapshots[?StartTime<='$(date -u -d '28 days ago' +%Y-%m-%dT%H:%M:%S)'].SnapshotId" \
    --output text)

for snap in $OLD_SNAPS; do
    aws ec2 delete-snapshot --snapshot-id "$snap" --region "$REGION"
    info "  Deleted old snapshot: $snap"
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  BACKUP COMPLETE: $TIMESTAMP"
echo "============================================"
echo "  MongoDB:  s3://${BACKUP_BUCKET}/mongodb/${WEEK}/"
echo "  Configs:  s3://${BACKUP_BUCKET}/configs/${WEEK}/"
echo "  Snapshot: $SNAPSHOT_ID"
echo "============================================"
