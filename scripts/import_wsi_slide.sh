#!/usr/bin/env bash
# =============================================================================
# import_wsi_slide.sh
#
# Files already on S3. For each slide folder under S3_PREFIX:
#   1. Import OME-TIFF  → Girder via S3 assetstore (no file copy)
#   2. Download label / macro / thumbnail from S3 → upload to Girder item
#   3. Set associated_images + scanner metadata on the imported item
#
# S3 structure expected:
#   s3://algopathp-pathssist-health/nssh/staging/<SLIDE_ID>/
#       <SLIDE_ID>.ome.tiff
#       barcodeImage.jpeg
#       whiteCorrectedInput.jpeg
#       <SLIDE_ID>.jpeg
#       metadata.json              (optional)
#
# All slides land flat in DEST_FOLDER_ID (no subfolders).
#
# Run on EC2:
#   GIRDER_USER=admin GIRDER_PASS=password ./import_wsi_slide.sh
#   GIRDER_TOKEN=xxxxx ./import_wsi_slide.sh
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
S3_BUCKET="algopathp-pathssist-health"
S3_PREFIX="nssh/staging"                        # prefix inside bucket (no trailing slash)
AWS_PROFILE="algopath"
GIRDER_BASE="http://localhost/api/v1"
DEST_FOLDER_ID="69c2cd747059d6d747dd64dd"       # flat destination — all slides go here
ASSETSTORE_ID="69a0ae0ca28f3a7fc0173829"
TMP_DIR="/tmp/wsi_import_tmp"
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

# ── Auth ──────────────────────────────────────────────────────────────────────
if [ -z "${GIRDER_TOKEN:-}" ]; then
    GIRDER_USER="${GIRDER_USER:-admin}"
    [ -z "${GIRDER_PASS:-}" ] && error "Set GIRDER_TOKEN or GIRDER_USER + GIRDER_PASS"
    GIRDER_TOKEN=$(curl -sf -X GET \
        "${GIRDER_BASE}/user/authentication" \
        -u "${GIRDER_USER}:${GIRDER_PASS}" | jq -r '.authToken.token')
fi
[ -z "$GIRDER_TOKEN" ] || [ "$GIRDER_TOKEN" = "null" ] && error "Could not obtain Girder token"
info "Authenticated with Girder ✓"

GH=(-H "Girder-Token: ${GIRDER_TOKEN}")
mkdir -p "$TMP_DIR"

# ── Helper: extract key fields from metadata.json ─────────────────────────────
extract_metadata() {
    local META_FILE="$1"
    [ -f "$META_FILE" ] || { echo "{}"; return; }
    python3 - "$META_FILE" << 'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        raw = json.load(f)
    data = raw.get("data", raw)
    result = {}
    for k in ("slide_name","biopsy_type","activity_status","number_of_z_stacks","scanner_type"):
        if k in data: result[k] = data[k]
    for k in ("focus_error_percentage","dark_region_percentage","faint_region_percentage"):
        if k in data: result[k] = data[k]
    if data.get("ocr_output"):
        result["ocr_text"] = " | ".join(str(x) for x in data["ocr_output"] if x)
    case = data.get("case_info", {})
    if isinstance(case, dict):
        for k in ("case_id","block_id","slide_num"):
            if case.get(k): result[k] = case[k]
    print(json.dumps(result))
except Exception:
    print("{}")
PYEOF
}

# ── Helper: upload a local file to a Girder item ─────────────────────────────
girder_upload_file() {
    local ITEM_ID="$1" FILE_PATH="$2" FILE_NAME="$3"
    local SIZE
    SIZE=$(stat -c%s "$FILE_PATH")

    # Init upload
    local INIT
    INIT=$(curl -sf -X POST "${GIRDER_BASE}/file" \
        "${GH[@]}" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "parentType=item" \
        --data-urlencode "parentId=${ITEM_ID}" \
        --data-urlencode "name=${FILE_NAME}" \
        --data-urlencode "mimeType=image/jpeg" \
        --data-raw "size=${SIZE}")

    local UPLOAD_ID BEHAVIOR
    UPLOAD_ID=$(echo "$INIT" | jq -r '._id')
    BEHAVIOR=$(echo "$INIT"  | jq -r '.behavior // "local"')

    if [ "$BEHAVIOR" = "s3" ]; then
        local S3_URL METHOD
        S3_URL=$(echo "$INIT" | jq -r '.s3.request.url')
        METHOD=$(echo "$INIT"  | jq -r '.s3.request.method // "PUT"')

        local HEADER_ARGS=()
        while IFS="=" read -r KEY VAL; do
            HEADER_ARGS+=(-H "${KEY}: ${VAL}")
        done < <(echo "$INIT" | jq -r '.s3.request.headers | to_entries[] | "\(.key)=\(.value)"')

        curl -sf -X "$METHOD" \
            "${HEADER_ARGS[@]}" \
            -H "Content-Length: ${SIZE}" \
            --data-binary "@${FILE_PATH}" \
            "${S3_URL}" > /dev/null

        curl -sf -X POST "${GIRDER_BASE}/file/completion" \
            "${GH[@]}" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            --data-raw "uploadId=${UPLOAD_ID}" | jq -r '._id'
    else
        curl -sf -X POST "${GIRDER_BASE}/file/chunk" \
            "${GH[@]}" \
            -G --data-raw "uploadId=${UPLOAD_ID}&offset=0" \
            --data-binary "@${FILE_PATH}" | jq -r '._id'
    fi
}

# ── List slide folders from S3 (or use single slide if SINGLE_SLIDE is set) ───
if [ -n "${SINGLE_SLIDE:-}" ]; then
    SLIDE_IDS=("$SINGLE_SLIDE")
    info "Single-slide mode: $SINGLE_SLIDE"
else
    step "Listing slide folders at s3://${S3_BUCKET}/${S3_PREFIX}/"
    mapfile -t SLIDE_IDS < <(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
        --profile "$AWS_PROFILE" \
        | awk '/PRE/ {gsub("/",""); print $2}')
fi

TOTAL=${#SLIDE_IDS[@]}
[ "$TOTAL" -eq 0 ] && error "No slide folders found at s3://${S3_BUCKET}/${S3_PREFIX}/"
info "Found $TOTAL slide folder(s)"

DONE=0; FAILED=0

for SLIDE_ID in "${SLIDE_IDS[@]}"; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    step "[$((DONE+FAILED+1))/$TOTAL]  $SLIDE_ID"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    S3_SLIDE="s3://${S3_BUCKET}/${S3_PREFIX}/${SLIDE_ID}"

    # Find OME-TIFF key in this folder
    OME_KEY=$(aws s3 ls "${S3_SLIDE}/" --profile "$AWS_PROFILE" \
        | awk '{print $4}' \
        | grep -E '\.ome\.tiff?$' | head -1)

    if [ -z "$OME_KEY" ]; then
        warn "No OME-TIFF found in ${S3_SLIDE}/ — skipping"
        FAILED=$((FAILED+1)); continue
    fi

    OME_NAME="$OME_KEY"
    IMPORT_PATH="${S3_PREFIX}/${SLIDE_ID}/${OME_NAME}"
    info "OME-TIFF:  $OME_NAME"

    # ── Step 1: Import OME-TIFF from S3 assetstore ───────────────────────────
    step "Importing from S3 assetstore → folder ${DEST_FOLDER_ID}"

    curl -sf -X POST \
        "${GIRDER_BASE}/assetstore/${ASSETSTORE_ID}/import" \
        "${GH[@]}" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "importPath=${IMPORT_PATH}" \
        --data-urlencode "destinationId=${DEST_FOLDER_ID}" \
        --data-urlencode "destinationType=folder" \
        --data-urlencode "leafFoldersAsItems=false" > /dev/null

    info "Import triggered ✓"

    # Wait for item to appear
    ITEM_ID=""
    for i in $(seq 1 12); do
        sleep 5
        ITEM_ID=$(curl -sf "${GIRDER_BASE}/item" \
            "${GH[@]}" -G \
            --data-urlencode "folderId=${DEST_FOLDER_ID}" \
            --data-urlencode "name=${OME_NAME}" \
            --data-urlencode "limit=1" | jq -r '.[0]._id // empty')
        [ -n "$ITEM_ID" ] && break
        info "  Waiting for item... (${i}/12)"
    done

    if [ -z "$ITEM_ID" ]; then
        warn "Item not found after 60s — skipping $SLIDE_ID"
        FAILED=$((FAILED+1)); continue
    fi
    info "Girder item: $ITEM_ID ✓"

    # ── Step 2: Download label/macro/thumbnail from S3 → upload to Girder ────
    step "Uploading associated images..."

    SLIDE_TMP="${TMP_DIR}/${SLIDE_ID}"
    mkdir -p "$SLIDE_TMP"

    LABEL_ID="" MACRO_ID="" THUMB_ID=""

    # Label
    if aws s3 cp "${S3_SLIDE}/barcodeImage.jpeg" "${SLIDE_TMP}/label.jpeg" \
        --profile "$AWS_PROFILE" --quiet 2>/dev/null; then
        LABEL_ID=$(girder_upload_file "$ITEM_ID" "${SLIDE_TMP}/label.jpeg" "label.jpeg" 2>/dev/null || echo "")
        [ -n "$LABEL_ID" ] && info "  label.jpeg     → $LABEL_ID" || warn "  label upload failed"
    else
        warn "  barcodeImage.jpeg not found on S3"
    fi

    # Macro
    if aws s3 cp "${S3_SLIDE}/whiteCorrectedInput.jpeg" "${SLIDE_TMP}/macro.jpeg" \
        --profile "$AWS_PROFILE" --quiet 2>/dev/null; then
        MACRO_ID=$(girder_upload_file "$ITEM_ID" "${SLIDE_TMP}/macro.jpeg" "macro.jpeg" 2>/dev/null || echo "")
        [ -n "$MACRO_ID" ] && info "  macro.jpeg     → $MACRO_ID" || warn "  macro upload failed"
    else
        warn "  whiteCorrectedInput.jpeg not found on S3"
    fi

    # Thumbnail
    if aws s3 cp "${S3_SLIDE}/${SLIDE_ID}.jpeg" "${SLIDE_TMP}/thumbnail.jpeg" \
        --profile "$AWS_PROFILE" --quiet 2>/dev/null; then
        THUMB_ID=$(girder_upload_file "$ITEM_ID" "${SLIDE_TMP}/thumbnail.jpeg" "thumbnail.jpeg" 2>/dev/null || echo "")
        [ -n "$THUMB_ID" ] && info "  thumbnail.jpeg → $THUMB_ID" || warn "  thumbnail upload failed"
    else
        warn "  ${SLIDE_ID}.jpeg not found on S3"
    fi

    # ── Step 3: Download metadata.json + set item metadata ───────────────────
    step "Setting metadata..."

    SCANNER_META="{}"
    if aws s3 cp "${S3_SLIDE}/metadata.json" "${SLIDE_TMP}/metadata.json" \
        --profile "$AWS_PROFILE" --quiet 2>/dev/null; then
        SCANNER_META=$(extract_metadata "${SLIDE_TMP}/metadata.json")
        info "  metadata.json extracted ✓"
    fi

    ASSOC=$(python3 -c "
import json, sys
a = {}
if sys.argv[1]: a['label']     = sys.argv[1]
if sys.argv[2]: a['macro']     = sys.argv[2]
if sys.argv[3]: a['thumbnail'] = sys.argv[3]
print(json.dumps(a))
" "$LABEL_ID" "$MACRO_ID" "$THUMB_ID")

    FINAL_META=$(jq -n \
        --argjson assoc   "$ASSOC" \
        --argjson scanner "$SCANNER_META" \
        --arg slide_id    "$SLIDE_ID" \
        --arg s3_path     "${S3_SLIDE}/${OME_NAME}" \
        --arg imported_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '$scanner + {
            associated_images: $assoc,
            slide_id:          $slide_id,
            s3_path:           $s3_path,
            imported_at:       $imported_at
        }')

    curl -sf -X PUT \
        "${GIRDER_BASE}/item/${ITEM_ID}/metadata" \
        "${GH[@]}" \
        -H "Content-Type: application/json" \
        -d "$FINAL_META" > /dev/null

    info "Metadata saved ✓"

    # Cleanup tmp
    rm -rf "$SLIDE_TMP"
    DONE=$((DONE+1))

    echo ""
    printf "  %-16s %s\n" "Slide:"     "$SLIDE_ID"
    printf "  %-16s %s\n" "Item ID:"   "$ITEM_ID"
    printf "  %-16s %s\n" "Label:"     "${LABEL_ID:-—}"
    printf "  %-16s %s\n" "Macro:"     "${MACRO_ID:-—}"
    printf "  %-16s %s\n" "Thumbnail:" "${THUMB_ID:-—}"
done

rm -rf "$TMP_DIR"

echo ""
echo "════════════════════════════════════════════"
printf "  DONE  %d imported,  %d failed  (total %d)\n" "$DONE" "$FAILED" "$TOTAL"
echo "════════════════════════════════════════════"
[ "$FAILED" -gt 0 ] && exit 1 || exit 0
