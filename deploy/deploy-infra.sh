#!/usr/bin/env bash
# =============================================================================
# deploy/deploy-infra.sh
#
# Deploy infrastructure config changes to EC2.
# Always: backs up current configs to S3 BEFORE applying changes.
# Always: pulls from git on EC2 (git is source of truth).
#
# Usage:
#   ./deploy/deploy-infra.sh              # deploy all infra configs
#   ./deploy/deploy-infra.sh nginx        # reload nginx only
#   ./deploy/deploy-infra.sh compose      # restart docker compose only
#   ./deploy/deploy-infra.sh keycloak     # start keycloak (first time)
#
# Files deployed (from git → EC2):
#   deploy/docker-compose.yml  → ver5/docker-compose.yml
#   deploy/nginx-multi.conf    → ver5/nginx-multi.conf
#   deploy/provision.yaml      → ver5/provision.yaml
#   deploy/dsa5.Dockerfile     → /opt/digital_slide_archive/dsa5.Dockerfile
# =============================================================================
set -euo pipefail

EC2_HOST="ubuntu@54.224.61.23"
SSH_KEY="${HOME}/.ssh/histamics20.pem"
COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"
BACKUP_BUCKET="pathassist-backups"
GIT_BRANCH="keycloak-integration"

MODE="${1:-all}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn()  { echo -e "${YELLOW}[$(date +%H:%M:%S)] WARN${NC} $*"; }
error() { echo -e "${RED}[$(date +%H:%M:%S)] ERROR${NC} $*"; exit 1; }

ssh_cmd() { ssh -i "$SSH_KEY" "$EC2_HOST" "$@"; }

# ── Step 0: Backup current configs to S3 BEFORE any changes ──────────────────
backup_configs() {
  info "==> [0] Backing up current configs to S3 (before changes)..."
  TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  ssh_cmd "cd $COMPOSE_DIR && tar -czf /tmp/configs_before_deploy_${TIMESTAMP}.tar.gz \
      docker-compose.yml nginx-multi.conf provision.yaml girder.cfg 2>/dev/null || true && \
      aws s3 cp /tmp/configs_before_deploy_${TIMESTAMP}.tar.gz \
      s3://${BACKUP_BUCKET}/configs/pre-deploy/configs_before_deploy_${TIMESTAMP}.tar.gz \
      --storage-class STANDARD_IA && \
      rm -f /tmp/configs_before_deploy_${TIMESTAMP}.tar.gz"
  info "    Backup saved to s3://${BACKUP_BUCKET}/configs/pre-deploy/ ✓"
}

# ── Step 1: Push local changes to git ────────────────────────────────────────
push_to_git() {
  info "==> [1] Pushing local changes to git..."
  cd "$(dirname "$0")/.."
  # Check if there are uncommitted changes
  if ! git diff --quiet HEAD -- deploy/; then
    warn "    You have uncommitted changes in deploy/. Commit them first:"
    git status deploy/
    error "Commit deploy/ changes before deploying."
  fi
  git push origin "$GIT_BRANCH"
  info "    Git push done ✓"
}

# ── Step 2: Pull on EC2 from git ──────────────────────────────────────────────
pull_on_ec2() {
  info "==> [2] git pull on EC2..."
  ssh_cmd "cd /opt/pathassist23 && git pull origin $GIT_BRANCH"
  info "    git pull done ✓"
}

# ── Step 3: Copy configs from git checkout to compose dir ────────────────────
copy_configs() {
  info "==> [3] Copying configs from git to compose directory..."
  ssh_cmd "cp /opt/pathassist23/deploy/docker-compose.yml $COMPOSE_DIR/docker-compose.yml"
  ssh_cmd "cp /opt/pathassist23/deploy/nginx-multi.conf   $COMPOSE_DIR/nginx-multi.conf"
  ssh_cmd "cp /opt/pathassist23/deploy/provision.yaml     $COMPOSE_DIR/provision.yaml"
  ssh_cmd "cp /opt/pathassist23/deploy/dsa5.Dockerfile    /opt/digital_slide_archive/dsa5.Dockerfile"
  info "    Configs copied ✓"
}

# ── Step 4: Apply changes ─────────────────────────────────────────────────────
apply_changes() {
  local mode="$1"

  if [[ "$mode" == "nginx" ]]; then
    info "==> [4] Reloading nginx..."
    ssh_cmd "cd $COMPOSE_DIR && docker compose restart nginx-proxy"

  elif [[ "$mode" == "compose" ]]; then
    info "==> [4] Applying docker-compose changes..."
    ssh_cmd "cd $COMPOSE_DIR && docker compose up -d --remove-orphans"

  elif [[ "$mode" == "keycloak" ]]; then
    info "==> [4] Starting Keycloak + PostgreSQL..."
    ssh_cmd "cd $COMPOSE_DIR && mkdir -p keycloak-db && docker compose up -d postgres-keycloak keycloak"
    info "    Keycloak starting (takes ~90 seconds)..."
    info "    Run ./deploy/keycloak-setup.sh after Keycloak is healthy"

  else
    # all — full apply
    info "==> [4] Applying all changes (docker compose up -d)..."
    ssh_cmd "cd $COMPOSE_DIR && docker compose up -d --remove-orphans"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
backup_configs
push_to_git
pull_on_ec2
copy_configs
apply_changes "$MODE"

echo ""
echo "============================================"
echo "  INFRA DEPLOY COMPLETE — mode: $MODE"
echo "============================================"
echo "  Backup: s3://${BACKUP_BUCKET}/configs/pre-deploy/"
echo "  EC2:    $EC2_HOST"
echo ""
if [[ "$MODE" == "keycloak" ]]; then
  echo "  NEXT: run ./deploy/keycloak-setup.sh"
  echo "  Admin: http://auth.pathassist.health/"
fi
echo "============================================"
