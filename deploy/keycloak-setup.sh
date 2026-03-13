#!/usr/bin/env bash
# =============================================================================
# deploy/keycloak-setup.sh
#
# ONE-TIME setup after first Keycloak boot.
# Run from local machine after deploying docker-compose with Keycloak:
#
#   ./deploy/keycloak-setup.sh
#
# What this does:
#   1. Waits for Keycloak to be healthy
#   2. Creates realm "pathassist"
#   3. Creates client "pathassist-girder" with correct redirect URIs
#   4. Gets the client secret
#   5. Sets the client secret in Girder via REST API
#   6. Creates default user roles in Keycloak
#
# Run ONCE after first boot. Safe to re-run (idempotent).
# =============================================================================
set -euo pipefail

EC2_HOST="ubuntu@54.224.61.23"
SSH_KEY="${HOME}/.ssh/histamics20.pem"
COMPOSE_DIR="/opt/digital_slide_archive/devops/ver5"

# Keycloak admin credentials (must match .env on EC2)
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-changeme_kc_admin}"
KC_REALM="pathassist"
KC_CLIENT_ID="pathassist-girder"

# Girder admin credentials
GIRDER_ADMIN_USER="${GIRDER_ADMIN_USER:-admin}"
GIRDER_ADMIN_PASS="${GIRDER_ADMIN_PASS:-password}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*"; }
warn()  { echo -e "${YELLOW}[$(date +%H:%M:%S)] WARN${NC} $*"; }
error() { echo -e "${RED}[$(date +%H:%M:%S)] ERROR${NC} $*"; exit 1; }

ssh_cmd() { ssh -i "$SSH_KEY" "$EC2_HOST" "$@"; }

# ── Step 1: Wait for Keycloak ─────────────────────────────────────────────────
info "==> [1/6] Waiting for Keycloak to be healthy..."
for i in $(seq 1 30); do
  STATUS=$(ssh_cmd "curl -sf http://localhost/health/ready 2>/dev/null && echo ok || echo fail")
  if [[ "$STATUS" == "ok" ]]; then
    info "    Keycloak is ready ✓"
    break
  fi
  echo "    Waiting... ($((i*10))s)"
  sleep 10
  [[ "$i" -eq 30 ]] && error "Keycloak did not become healthy after 5 minutes"
done

# ── Step 2: Create realm ──────────────────────────────────────────────────────
info "==> [2/6] Creating realm: $KC_REALM"
ssh_cmd "docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user '$KC_ADMIN_USER' \
    --password '$KC_ADMIN_PASSWORD'"

# Create realm (ignore error if already exists)
ssh_cmd "docker exec keycloak /opt/keycloak/bin/kcadm.sh create realms \
    -s realm='$KC_REALM' \
    -s enabled=true \
    -s displayName='PathAssist' \
    -s registrationAllowed=false \
    -s loginWithEmailAllowed=true \
    -s rememberMe=true \
    -s accessTokenLifespan=3600 2>/dev/null || true"
info "    Realm '$KC_REALM' ready ✓"

# ── Step 3: Create client ─────────────────────────────────────────────────────
info "==> [3/6] Creating client: $KC_CLIENT_ID"

# All redirect URIs (one per domain)
REDIRECT_URIS='[
  "http://impart.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://impart.dev.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://mda.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://mda.dev.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://algopath.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://algopath.dev.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://lymphoma.dev.pathassist.health/api/v1/oauth/keycloak/callback",
  "http://23.pathassist.health/api/v1/oauth/keycloak/callback"
]'

ssh_cmd "docker exec keycloak /opt/keycloak/bin/kcadm.sh create clients \
    -r '$KC_REALM' \
    -s clientId='$KC_CLIENT_ID' \
    -s enabled=true \
    -s 'redirectUris=$REDIRECT_URIS' \
    -s 'webOrigins=[\"*\"]' \
    -s publicClient=false \
    -s serviceAccountsEnabled=true \
    -s authorizationServicesEnabled=false \
    -s standardFlowEnabled=true \
    -s directAccessGrantsEnabled=false 2>/dev/null || true"
info "    Client '$KC_CLIENT_ID' ready ✓"

# ── Step 4: Get client secret ─────────────────────────────────────────────────
info "==> [4/6] Retrieving client secret..."
CLIENT_INTERNAL_ID=$(ssh_cmd "docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients \
    -r '$KC_REALM' \
    --fields id,clientId 2>/dev/null \
    | python3 -c \"import sys,json; data=json.load(sys.stdin); print(next(c['id'] for c in data if c['clientId']=='$KC_CLIENT_ID'))\"")

CLIENT_SECRET=$(ssh_cmd "docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients/${CLIENT_INTERNAL_ID}/client-secret \
    -r '$KC_REALM' 2>/dev/null \
    | python3 -c \"import sys,json; print(json.load(sys.stdin)['value'])\"")

info "    Client secret retrieved ✓"

# ── Step 5: Set Girder OAuth settings ────────────────────────────────────────
info "==> [5/6] Configuring Girder OAuth settings..."

# Get Girder admin token
GIRDER_TOKEN=$(ssh_cmd "curl -sf -X GET http://localhost:8080/api/v1/user/authentication \
    -u '${GIRDER_ADMIN_USER}:${GIRDER_ADMIN_PASS}' \
    -H 'Accept: application/json' | python3 -c \"import sys,json; print(json.load(sys.stdin)['authToken']['token'])\"")

# Set OAuth settings in Girder
ssh_cmd "curl -sf -X PUT http://localhost:8080/api/v1/system/setting \
    -H 'Girder-Token: $GIRDER_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"key\": \"oauth.keycloak_client_secret\", \"value\": \"$CLIENT_SECRET\"}'"

ssh_cmd "curl -sf -X PUT http://localhost:8080/api/v1/system/setting \
    -H 'Girder-Token: $GIRDER_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"key\": \"oauth.providers_enabled\", \"value\": [\"keycloak\"]}'"

ssh_cmd "curl -sf -X PUT http://localhost:8080/api/v1/system/setting \
    -H 'Girder-Token: $GIRDER_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"key\": \"oauth.keycloak_client_id\", \"value\": \"$KC_CLIENT_ID\"}'"

ssh_cmd "curl -sf -X PUT http://localhost:8080/api/v1/system/setting \
    -H 'Girder-Token: $GIRDER_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"key\": \"oauth.keycloak_base_url\", \"value\": \"http://auth.pathassist.health\"}'"

ssh_cmd "curl -sf -X PUT http://localhost:8080/api/v1/system/setting \
    -H 'Girder-Token: $GIRDER_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"key\": \"oauth.keycloak_realm\", \"value\": \"$KC_REALM\"}'"

info "    Girder OAuth settings updated ✓"

# ── Step 6: Create default roles (Keycloak groups) ───────────────────────────
info "==> [6/6] Creating default roles in Keycloak..."

for ROLE in pathologist admin lab-assist radiologist researcher; do
  ssh_cmd "docker exec keycloak /opt/keycloak/bin/kcadm.sh create groups \
      -r '$KC_REALM' -s name='$ROLE' 2>/dev/null || true"
  info "    Group: $ROLE ✓"
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  KEYCLOAK SETUP COMPLETE"
echo "============================================================"
echo "  Realm:          $KC_REALM"
echo "  Client:         $KC_CLIENT_ID"
echo "  Client secret:  $CLIENT_SECRET"
echo "  Admin console:  http://auth.pathassist.health/"
echo "  Admin login:    $KC_ADMIN_USER / (your KC_ADMIN_PASSWORD)"
echo ""
echo "  NEXT STEPS:"
echo "  1. Open http://auth.pathassist.health/ to verify admin console"
echo "  2. Create users in Keycloak realm '$KC_REALM'"
echo "  3. Test SSO: click 'Sign in with Keycloak' on any PathAssist domain"
echo "============================================================"
echo ""
echo "  CLIENT SECRET (save this safely):"
echo "  $CLIENT_SECRET"
echo "============================================================"
