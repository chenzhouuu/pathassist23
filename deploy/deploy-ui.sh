#!/usr/bin/env bash
# =============================================================================
# deploy/deploy-ui.sh
#
# Deploy the latest UI build to EC2.
# Run from your local machine:
#
#   ./deploy/deploy-ui.sh                  # deploy Impart DX (lymphoma)
#   ./deploy/deploy-ui.sh mda              # deploy MDA brand
#   ./deploy/deploy-ui.sh algopath         # deploy Algopath brand
#   ./deploy/deploy-ui.sh all              # deploy all 3 brands
#
# =============================================================================
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
EC2_HOST="ubuntu@54.224.61.23"
SSH_KEY="${HOME}/.ssh/histamics20.pem"
EC2_SOURCE="/opt/pathassist23"
EC2_COMPOSE="/opt/digital_slide_archive/devops/ver5"

# Deployment policy:
#   lymphoma (impart) = LATEST always  — dev/test environment
#   mda + algopath    = ONE VERSION BEHIND — stable/production
#
# Brand definitions: "container_name|target_dir|VITE_APP_NAME|VITE_LOGO_SRC|VITE_APP_TAGLINE"
declare -A BRANDS
BRANDS[lymphoma]="pathassist-lymphoma|/opt/pathassist-lymphoma|Impart DX|/impart-dx-logo.png|Digital Pathology Platform"
BRANDS[mda]="pathassist-mda|/opt/pathassist-mda|MDA PathAssist|/mda-logo.png|Digital Pathology Platform"
BRANDS[algopath]="pathassist-algopath|/opt/pathassist-algopath|Algopath|/alogopath-logo.png|Digital Pathology Platform"

# ── Args ──────────────────────────────────────────────────────────────────────
BRAND="${1:-lymphoma}"

if [[ "$BRAND" == "all" ]]; then
  DEPLOY_BRANDS=("lymphoma" "mda" "algopath")
else
  DEPLOY_BRANDS=("$BRAND")
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
ssh_cmd() { ssh -i "$SSH_KEY" "$EC2_HOST" "$@"; }

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] WARN${NC} $*"; }

# ── Step 1: Pull latest code on EC2 ──────────────────────────────────────────
info "==> [1] git pull on EC2 ($EC2_SOURCE)"
ssh_cmd "cd $EC2_SOURCE && git pull"

# ── Step 2: Build + Copy each brand ──────────────────────────────────────────
for BRAND in "${DEPLOY_BRANDS[@]}"; do
  IFS='|' read -r CONTAINER TARGET APP_NAME LOGO TAGLINE <<< "${BRANDS[$BRAND]}"

  info "==> [2] Building brand: $BRAND ($APP_NAME)"
  ssh_cmd "cd $EC2_SOURCE && \
    VITE_APP_NAME='$APP_NAME' \
    VITE_LOGO_SRC='$LOGO' \
    VITE_APP_TAGLINE='$TAGLINE' \
    npm run build 2>&1 | tail -5"

  info "==> [3] Copying dist → $TARGET/dist/"
  ssh_cmd "rm -rf $TARGET/dist/* && cp -r $EC2_SOURCE/dist/. $TARGET/dist/"

  info "==> [4] Restarting container: $CONTAINER"
  ssh_cmd "cd $EC2_COMPOSE && docker compose restart $CONTAINER"

  info "    $BRAND deployed ✓"
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  DEPLOY COMPLETE"
for BRAND in "${DEPLOY_BRANDS[@]}"; do
  IFS='|' read -r _ _ APP_NAME _ _ <<< "${BRANDS[$BRAND]}"
  echo "  $BRAND → $APP_NAME"
done
echo "============================================"
