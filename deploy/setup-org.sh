#!/usr/bin/env bash
# =============================================================================
# deploy/setup-org.sh
#
# Creates a complete organization in Keycloak + Girder:
#   - 3 Keycloak groups: /<slug>-admin, /<slug>-pathologist, /<slug>-lab-manager
#   - 3 Keycloak users:  <slug>.admin, <slug>.pathologist, <slug>.labmanager
#   - 3 Girder groups matching Keycloak paths (for SSO auto-sync)
#   - ACL on the specified Girder collection
#
# Usage:
#   ./deploy/setup-org.sh \
#     --slug mda \
#     --collection-id 6800883a0f8c9e902263c1b7 \
#     --email-domain pathassist.health \
#     --password MDA@Pass2024!
#
#   # Or set environment variables:
#   ORG_SLUG=acme ORG_COL_ID=abc123 ./deploy/setup-org.sh
#
# =============================================================================
set -euo pipefail

# ── Defaults (override via args or env) ──────────────────────────────────────
KC_URL="${KC_URL:-https://auth.pathassist.health}"
GIRDER_URL="${GIRDER_URL:-https://impart.pathassist.health/api/v1}"
KC_REALM="${KC_REALM:-pathassist}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASS="${KC_ADMIN_PASS:-PathAssist@1234!}"
GIRDER_ADMIN_USER="${GIRDER_ADMIN_USER:-admin}"
GIRDER_ADMIN_PASS="${GIRDER_ADMIN_PASS:-password}"

ORG_SLUG=""
ORG_COL_ID=""
EMAIL_DOMAIN="${EMAIL_DOMAIN:-pathassist.health}"
USER_PASS="${USER_PASS:-}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --slug)            ORG_SLUG="$2";        shift 2;;
    --collection-id)   ORG_COL_ID="$2";      shift 2;;
    --email-domain)    EMAIL_DOMAIN="$2";    shift 2;;
    --password)        USER_PASS="$2";       shift 2;;
    --kc-url)          KC_URL="$2";          shift 2;;
    --girder-url)      GIRDER_URL="$2";      shift 2;;
    *) error "Unknown argument: $1";;
  esac
done

# Fallback to env vars
ORG_SLUG="${ORG_SLUG:-${ORG_SLUG:-}}"
ORG_COL_ID="${ORG_COL_ID:-${ORG_COL_ID:-}}"

[[ -z "$ORG_SLUG" ]]    && error "Required: --slug <org-slug> (e.g. mda, bmjh, stanford)"
[[ -z "$ORG_COL_ID" ]]  && error "Required: --collection-id <girder-collection-id>"
[[ -z "$USER_PASS" ]]   && USER_PASS="${ORG_SLUG^}@Pass2024!"

info "Setting up org: $ORG_SLUG (collection: $ORG_COL_ID)"
info "User password:  $USER_PASS"

# ── Auth ─────────────────────────────────────────────────────────────────────
info "Authenticating..."
KC_TOKEN=$(curl -s "$KC_URL/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN_USER}&password=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${KC_ADMIN_PASS}'))")" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
[[ -z "$KC_TOKEN" ]] && error "Failed to get Keycloak token"
info "Keycloak OK"

GIRDER_TOKEN=$(curl -s -u "${GIRDER_ADMIN_USER}:${GIRDER_ADMIN_PASS}" "$GIRDER_URL/user/authentication" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["authToken"]["token"])')
[[ -z "$GIRDER_TOKEN" ]] && error "Failed to get Girder token"
info "Girder OK"

kc_get()  { curl -s "$KC_URL/admin/realms/$KC_REALM/$1" -H "Authorization: Bearer $KC_TOKEN"; }
kc_post() { curl -s -X POST "$KC_URL/admin/realms/$KC_REALM/$1" -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' -d "$2"; }
kc_put()  { curl -s -X PUT  "$KC_URL/admin/realms/$KC_REALM/$1" -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' -d "$2"; }
gd_get()  { curl -s "$GIRDER_URL/$1" -H "Girder-Token: $GIRDER_TOKEN"; }
gd_post() { curl -s -X POST "$GIRDER_URL/$1" -H "Girder-Token: $GIRDER_TOKEN" -H 'Content-Length: 0'; }

# ── Step 1: Keycloak groups ───────────────────────────────────────────────────
info "Creating Keycloak groups..."
for G in "${ORG_SLUG}-admin" "${ORG_SLUG}-pathologist" "${ORG_SLUG}-lab-manager"; do
  EXISTS=$(kc_get "groups?search=$G" | python3 -c "import sys,json; d=[g for g in json.load(sys.stdin) if g['name']=='$G']; print(d[0]['id'] if d else '')")
  if [ -z "$EXISTS" ]; then
    kc_post "groups" "{\"name\":\"$G\"}" > /dev/null
    info "  Created: /$G"
  else
    warn "  Exists:  /$G"
  fi
done

# ── Step 2: Keycloak users ────────────────────────────────────────────────────
info "Creating Keycloak users..."
ADMIN_KUID="" PATHO_KUID="" LAB_KUID=""

for ROW in "${ORG_SLUG}.admin:${ORG_SLUG}.admin@${EMAIL_DOMAIN}:${ORG_SLUG^}:Admin" \
           "${ORG_SLUG}.pathologist:${ORG_SLUG}.pathologist@${EMAIL_DOMAIN}:${ORG_SLUG^}:Pathologist" \
           "${ORG_SLUG}.labmanager:${ORG_SLUG}.labmanager@${EMAIL_DOMAIN}:${ORG_SLUG^}:LabManager"; do
  LOGIN=$(echo $ROW | cut -d: -f1)
  EMAIL=$(echo $ROW | cut -d: -f2)
  FNAME=$(echo $ROW | cut -d: -f3)
  LNAME=$(echo $ROW | cut -d: -f4)

  KUID=$(kc_get "users?username=$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
  if [ -z "$KUID" ]; then
    kc_post "users" "{\"username\":\"$LOGIN\",\"email\":\"$EMAIL\",\"firstName\":\"$FNAME\",\"lastName\":\"$LNAME\",\"enabled\":true,\"emailVerified\":true,\"credentials\":[{\"type\":\"password\",\"value\":\"$USER_PASS\",\"temporary\":false}]}" > /dev/null
    KUID=$(kc_get "users?username=$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
    info "  Created: $LOGIN ($KUID)"
  else
    warn "  Exists:  $LOGIN ($KUID)"
  fi
  [[ "$LOGIN" == *"admin"* && "$LOGIN" != *"lab"* ]] && ADMIN_KUID=$KUID
  [[ "$LOGIN" == *"pathologist"* ]]                   && PATHO_KUID=$KUID
  [[ "$LOGIN" == *"labmanager"* ]]                    && LAB_KUID=$KUID
done

# ── Step 3: Assign groups ─────────────────────────────────────────────────────
info "Assigning group memberships..."
get_gid() { kc_get "groups?search=$1" | python3 -c "import sys,json; d=[g for g in json.load(sys.stdin) if g['name']=='$1']; print(d[0]['id'] if d else '')"; }
assign() { kc_put "users/$1/groups/$2" '{}' > /dev/null; }

GID_ORG_ADMIN=$(get_gid "${ORG_SLUG}-admin")
GID_ORG_PATHO=$(get_gid "${ORG_SLUG}-pathologist")
GID_ORG_LAB=$(get_gid "${ORG_SLUG}-lab-manager")
GID_LABMGR=$(get_gid "lab-manager")
GID_PATHO=$(get_gid "pathologist")

assign $ADMIN_KUID $GID_ORG_ADMIN; assign $ADMIN_KUID $GID_LABMGR
info "  ${ORG_SLUG}.admin        -> /${ORG_SLUG}-admin + /lab-manager"
assign $PATHO_KUID $GID_ORG_PATHO; assign $PATHO_KUID $GID_PATHO
info "  ${ORG_SLUG}.pathologist  -> /${ORG_SLUG}-pathologist + /pathologist"
assign $LAB_KUID $GID_ORG_LAB; assign $LAB_KUID $GID_LABMGR
info "  ${ORG_SLUG}.labmanager   -> /${ORG_SLUG}-lab-manager + /lab-manager"

# ── Step 4: Girder groups + collection ACL ────────────────────────────────────
info "Creating Girder groups..."
make_gd_group() {
  local NAME=$1 ENC GID
  ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$NAME'))")
  GID=$(gd_get "group?text=$ENC&exact=true" | python3 -c "import sys,json; d=[g for g in json.load(sys.stdin) if g['name']=='$NAME']; print(d[0]['_id'] if d else '')")
  if [ -z "$GID" ]; then
    GID=$(gd_post "group?name=$ENC&public=false" | python3 -c 'import sys,json; print(json.load(sys.stdin)["_id"])')
    info "  Created Girder group: $NAME ($GID)"
  else
    warn "  Exists  Girder group: $NAME ($GID)"
  fi
  echo "$GID"
}

GG_ADMIN=$(make_gd_group "${ORG_SLUG}-admin")
GG_PATHO=$(make_gd_group "${ORG_SLUG}-pathologist")
GG_LAB=$(make_gd_group "${ORG_SLUG}-lab-manager")

info "Applying collection ACL..."
curl -s -X PUT "$GIRDER_URL/collection/$ORG_COL_ID/access" \
  -H "Girder-Token: $GIRDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"groups\":[{\"id\":\"$GG_ADMIN\",\"level\":1},{\"id\":\"$GG_PATHO\",\"level\":0},{\"id\":\"$GG_LAB\",\"level\":1}],\"users\":[]}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"  {len(d.get(\"groups\",[]))} group(s) in ACL")' 2>/dev/null || warn "ACL applied (no parseable response)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ORG SETUP COMPLETE: ${ORG_SLUG^^}${NC}"
echo -e "${GREEN}============================================${NC}"
echo "  Collection ID : $ORG_COL_ID"
echo "  User password : $USER_PASS"
echo ""
echo "  ${ORG_SLUG}.admin        /WRITE  -> /${ORG_SLUG}-admin + /lab-manager"
echo "  ${ORG_SLUG}.pathologist  /READ   -> /${ORG_SLUG}-pathologist + /pathologist"
echo "  ${ORG_SLUG}.labmanager   /WRITE  -> /${ORG_SLUG}-lab-manager + /lab-manager"
echo ""
echo "  Next steps:"
echo "  1. Test login at the app URL with ${ORG_SLUG}.admin / $USER_PASS"
echo "  2. Set assetstore metadata if importing from S3:"
echo "     ADMIN_PASS=password bash deploy/update-bmjh-assetstore.sh  (adapt for $ORG_SLUG)"
echo -e "${GREEN}============================================${NC}"
