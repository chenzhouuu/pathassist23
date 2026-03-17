#!/usr/bin/env bash
# =============================================================================
# deploy/update-bmjh-assetstore.sh
#
# Updates the BMJH collection metadata to point to the bmjh-assetstore.
# Run from EC2 server or via SSH.
#
# Usage:
#   ./deploy/update-bmjh-assetstore.sh
#   SSH_KEY=~/.ssh/histamics20.pem ./deploy/update-bmjh-assetstore.sh --remote
#
# =============================================================================
set -euo pipefail

GIRDER_URL="${GIRDER_URL:-https://impart.pathassist.health/api/v1}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-PathAssist@1234!}"

# bmjh-assetstore details (Girder assetstore ID)
ASSETSTORE_ID="699d3abc4ff1970e74173828"
ASSETSTORE_NAME="bmjh-assetstore"
ASSETSTORE_TYPE="S3"
# Bucket name — update if different
ASSETSTORE_BUCKET="histomic20-new"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Authenticate ─────────────────────────────────────────────────────────────
info "Authenticating with Girder..."
AUTH=$(echo -n "${ADMIN_USER}:${ADMIN_PASS}" | base64 -w0)
TOKEN=$(curl -sf "${GIRDER_URL}/user/authentication" \
  -H "Authorization: Basic ${AUTH}" | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken']['token'])")
[[ -z "$TOKEN" ]] && error "Failed to get Girder token"
info "Got token: ${TOKEN:0:12}..."

H="-H 'Girder-Token: $TOKEN'"

# ── Find BMJH collection ──────────────────────────────────────────────────────
info "Finding BMJH collection..."
COLLECTIONS=$(curl -sf "${GIRDER_URL}/collection?limit=200&sort=name" \
  -H "Girder-Token: $TOKEN")

BMJH_ID=$(echo "$COLLECTIONS" | python3 -c "
import sys, json
cols = json.load(sys.stdin)
bmjh = next((c for c in cols if 'BMJH' in c.get('name','').upper()), None)
print(bmjh['_id'] if bmjh else '')
")

[[ -z "$BMJH_ID" ]] && error "BMJH collection not found. Create it first."
info "Found BMJH collection: $BMJH_ID"

# ── Get assetstore bucket name from Girder ────────────────────────────────────
info "Fetching assetstore details..."
STORE=$(curl -sf "${GIRDER_URL}/assetstore/${ASSETSTORE_ID}" \
  -H "Girder-Token: $TOKEN" 2>/dev/null || echo '{}')

# Try to get bucket from store info
BUCKET=$(echo "$STORE" | python3 -c "
import sys,json
s=json.load(sys.stdin)
print(s.get('bucket','') or s.get('prefix','') or '')
" 2>/dev/null || echo "$ASSETSTORE_BUCKET")

[[ -n "$BUCKET" ]] && ASSETSTORE_BUCKET="$BUCKET"
info "Assetstore bucket: $ASSETSTORE_BUCKET"

# ── Update collection metadata ────────────────────────────────────────────────
info "Updating BMJH collection metadata..."
RESULT=$(curl -sf -X PUT \
  "${GIRDER_URL}/collection/${BMJH_ID}/metadata" \
  -H "Girder-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"assetstoreId\": \"${ASSETSTORE_ID}\",
    \"assetstoreName\": \"${ASSETSTORE_NAME}\",
    \"assetstoreType\": \"${ASSETSTORE_TYPE}\",
    \"assetstoreBucket\": \"${ASSETSTORE_BUCKET}\"
  }")

echo "$RESULT" | python3 -c "
import sys,json
m=json.load(sys.stdin).get('meta',{})
print('  assetstoreId   :', m.get('assetstoreId','?'))
print('  assetstoreName :', m.get('assetstoreName','?'))
print('  assetstoreType :', m.get('assetstoreType','?'))
print('  assetstoreBucket:', m.get('assetstoreBucket','?'))
"

info "BMJH collection metadata updated. Import modal will now use bmjh-assetstore."
