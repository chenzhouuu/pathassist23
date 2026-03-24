#!/bin/bash
# =============================================================================
# upload_and_import.sh
#
# 1. Extracts OME-TIFF files from ZIP on NAS
# 2. Uploads to S3 under s3://algopathp-pathssist-health/<patient_name>/
# 3. Creates a folder in Girder collection (694f13b58f7f83d2b00dd62a)
#    named after the patient
# 4. Imports files via Girder assetstore (69a0ae0ca28f3a7fc0173829)
#
# Usage:
#   ./upload_and_import.sh <patient_name> <folder_name>
#
# Requirements:
#   - aws CLI configured with profile "algopath"
#   - GIRDER_TOKEN env var set  OR  GIRDER_USER + GIRDER_PASS env vars set
#   - curl, jq, unzip installed
#
# Example:
#   GIRDER_TOKEN=xxxxx ./upload_and_import.sh "John_Doe" "JD_20260312"
# =============================================================================

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
PATIENT_NAME="${1:-}"
FOLDER_NAME="${2:-}"

if [ -z "$PATIENT_NAME" ] || [ -z "$FOLDER_NAME" ]; then
    echo "Usage: $0 <patient_name> <folder_name>"
    exit 1
fi

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR="/mnt/clusterNas/dicom_data"
ZIP_FILE="${BASE_DIR}/${FOLDER_NAME}/${FOLDER_NAME}.zip"
WORK_DIR="/tmp/${FOLDER_NAME}_extract"

S3_BUCKET="s3://algopathp-pathssist-health"
S3_DEST="${S3_BUCKET}/${PATIENT_NAME}/"
AWS_PROFILE="algopath"

GIRDER_BASE="http://localhost:8080/api/v1"   # internal — no internet round-trip
COLLECTION_ID="694f13b58f7f83d2b00dd62a"
ASSETSTORE_ID="69a0ae0ca28f3a7fc0173829"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Dependency check ──────────────────────────────────────────────────────────
for cmd in aws curl jq unzip; do
    command -v "$cmd" &>/dev/null || error "$cmd is required but not installed"
done

# ── Step 0: Authenticate with Girder ─────────────────────────────────────────
info "Authenticating with Girder..."

if [ -z "${GIRDER_TOKEN:-}" ]; then
    # Login with username/password if token not provided
    GIRDER_USER="${GIRDER_USER:-admin}"
    GIRDER_PASS="${GIRDER_PASS:-}"
    if [ -z "$GIRDER_PASS" ]; then
        error "Set GIRDER_TOKEN or GIRDER_USER + GIRDER_PASS env vars"
    fi
    GIRDER_TOKEN=$(curl -sf -X GET \
        "${GIRDER_BASE}/user/authentication" \
        -u "${GIRDER_USER}:${GIRDER_PASS}" \
        -H "Accept: application/json" | jq -r '.authToken.token')
fi

[ -z "$GIRDER_TOKEN" ] && error "Could not obtain Girder token"
info "Girder authenticated ✓"

# Helper: Girder API call
girder() {
    local METHOD="$1"; shift
    local ENDPOINT="$1"; shift
    curl -sf -X "$METHOD" \
        "${GIRDER_BASE}${ENDPOINT}" \
        -H "Girder-Token: ${GIRDER_TOKEN}" \
        -H "Content-Type: application/json" \
        "$@"
}

# ── Step 1: Extract ZIP ───────────────────────────────────────────────────────
info "Patient:  $PATIENT_NAME"
info "Folder:   $FOLDER_NAME"
info "ZIP file: $ZIP_FILE"

[ -f "$ZIP_FILE" ] || error "ZIP file not found: $ZIP_FILE"

mkdir -p "$WORK_DIR"
info "Extracting ZIP..."
unzip -o "$ZIP_FILE" -d "$WORK_DIR" | tail -5
echo "..."

# ── Step 2: Find OME-TIFF files ───────────────────────────────────────────────
mapfile -t OME_FILES < <(find "$WORK_DIR" -type f \( -iname "*.ome.tif" -o -iname "*.ome.tiff" \))

if [ ${#OME_FILES[@]} -eq 0 ]; then
    rm -rf "$WORK_DIR"
    error "No OME-TIFF files found in ZIP"
fi

info "Found ${#OME_FILES[@]} OME-TIFF file(s):"
for f in "${OME_FILES[@]}"; do
    SIZE=$(du -sh "$f" | cut -f1)
    echo "    $SIZE  $(basename "$f")"
done

# ── Step 2.5: Embed label/macro into each OME-TIFF + collect metadata ────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMBED_SCRIPT="${SCRIPT_DIR}/embed_slide_images.py"
declare -A SLIDE_METADATA  # item_name -> metadata JSON

if [ -f "$EMBED_SCRIPT" ] && command -v python3 &>/dev/null; then
    info "Embedding label/macro images into OME-TIFF files..."
    for FILE in "${OME_FILES[@]}"; do
        FILENAME=$(basename "$FILE")
        SLIDE_ID="${FILENAME%.ome.tiff}"
        SLIDE_ID="${SLIDE_ID%.ome.tif}"

        # Look for scanner output folder alongside the OME-TIFF
        SLIDE_FOLDER="$(dirname "$FILE")/${SLIDE_ID}"

        if [ -d "$SLIDE_FOLDER" ]; then
            info "  Processing: $FILENAME"
            META_JSON=$(python3 "$EMBED_SCRIPT" "$SLIDE_FOLDER" "$FILE" 2>/dev/null || echo "{}")
            SLIDE_METADATA["$FILENAME"]="$META_JSON"
            info "  ✓ Embedded + metadata extracted: $FILENAME"
        else
            warn "  No scanner folder found for $FILENAME (expected: $SLIDE_FOLDER) — skipping embed"
            SLIDE_METADATA["$FILENAME"]="{}"
        fi
    done
else
    warn "embed_slide_images.py not found or python3 unavailable — skipping embed step"
fi

# ── Step 3: Upload to S3 ──────────────────────────────────────────────────────
info "Uploading to S3: ${S3_DEST}"

UPLOADED=0
FAILED=0
for FILE in "${OME_FILES[@]}"; do
    FILENAME=$(basename "$FILE")
    info "  Uploading: $FILENAME"
    if aws s3 cp "$FILE" "${S3_DEST}${FILENAME}" \
        --profile "$AWS_PROFILE" \
        --no-progress \
        --expected-size $(stat -c%s "$FILE"); then
        UPLOADED=$((UPLOADED + 1))
        info "  ✓ $FILENAME"
    else
        warn "  ✗ Failed: $FILENAME"
        FAILED=$((FAILED + 1))
    fi
done

[ "$FAILED" -gt 0 ] && error "$FAILED file(s) failed to upload. Aborting Girder import."
info "S3 upload complete: $UPLOADED file(s) ✓"

# ── Step 4: Create/find patient folder in Girder collection ──────────────────
info "Creating patient folder in Girder collection..."

# Check if folder already exists
EXISTING_FOLDER=$(girder GET \
    "/folder?parentType=collection&parentId=${COLLECTION_ID}&name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${PATIENT_NAME}',$''))")&limit=1" \
    2>/dev/null | jq -r '.[0]._id // empty')

if [ -n "$EXISTING_FOLDER" ]; then
    FOLDER_ID="$EXISTING_FOLDER"
    warn "Folder already exists: $PATIENT_NAME ($FOLDER_ID) — reusing"
else
    FOLDER_RESPONSE=$(girder POST "/folder" \
        --data-raw "{
            \"parentType\": \"collection\",
            \"parentId\": \"${COLLECTION_ID}\",
            \"name\": \"${PATIENT_NAME}\",
            \"description\": \"Imported from S3 on $(date -u +%Y-%m-%dT%H:%M:%SZ)\"
        }")

    FOLDER_ID=$(echo "$FOLDER_RESPONSE" | jq -r '._id')
    [ -z "$FOLDER_ID" ] || [ "$FOLDER_ID" == "null" ] && \
        error "Failed to create Girder folder: $FOLDER_RESPONSE"
    info "Created folder: $PATIENT_NAME ($FOLDER_ID) ✓"
fi

# ── Step 5: Import from assetstore into the folder ───────────────────────────
info "Importing from assetstore into folder..."
info "  Assetstore:  $ASSETSTORE_ID"
info "  Import path: ${PATIENT_NAME}/"
info "  Destination: $FOLDER_ID"

IMPORT_RESPONSE=$(curl -sf -X POST \
    "${GIRDER_BASE}/assetstore/${ASSETSTORE_ID}/import" \
    -H "Girder-Token: ${GIRDER_TOKEN}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "importPath=${PATIENT_NAME}/" \
    --data-urlencode "destinationId=${FOLDER_ID}" \
    --data-urlencode "destinationType=folder" \
    --data-urlencode "fileExcludeRegex=" \
    --data-urlencode "leafFoldersAsItems=false" \
    --data-urlencode "progress=true")

# Check if it returned a job
JOB_ID=$(echo "$IMPORT_RESPONSE" | jq -r '._id // empty' 2>/dev/null)

if [ -n "$JOB_ID" ]; then
    info "Import job started: $JOB_ID"
    info "Polling job status..."

    for i in $(seq 1 60); do
        sleep 5
        JOB_STATUS=$(girder GET "/job/${JOB_ID}" | jq -r '.status')
        # Girder job status: 0=inactive,1=queued,2=running,3=success,4=error,5=cancelled
        case "$JOB_STATUS" in
            3) info "Import job completed successfully ✓"; break ;;
            4) error "Import job failed. Check Girder job logs: $JOB_ID" ;;
            5) error "Import job was cancelled." ;;
            *) echo "    Status: $JOB_STATUS — waiting... ($((i*5))s)" ;;
        esac
        [ "$i" -eq 60 ] && warn "Job still running after 5 min — check manually: $JOB_ID"
    done
else
    # Some Girder versions return empty on success
    info "Import triggered ✓"
fi

# ── Step 6: Verify items and attach extracted metadata ───────────────────────
info "Verifying imported items in Girder..."
ITEMS_JSON=$(girder GET "/item?folderId=${FOLDER_ID}&limit=200")
ITEM_COUNT=$(echo "$ITEMS_JSON" | jq 'length')
info "Items in folder '${PATIENT_NAME}': $ITEM_COUNT"

if [ "$ITEM_COUNT" -eq 0 ]; then
    warn "No items found yet — import may still be processing"
else
    info "Attaching scanner metadata to imported items..."
    while IFS= read -r item; do
        ITEM_ID=$(echo "$item" | jq -r '._id')
        ITEM_NAME=$(echo "$item" | jq -r '.name')

        # Match item name to our collected metadata
        META="${SLIDE_METADATA[$ITEM_NAME]:-}"
        if [ -n "$META" ] && [ "$META" != "{}" ]; then
            # Merge with any existing item meta
            EXISTING_META=$(girder GET "/item/${ITEM_ID}" | jq '.meta // {}')
            MERGED=$(echo "$EXISTING_META $META" | jq -s 'add')

            curl -sf -X PUT \
                "${GIRDER_BASE}/item/${ITEM_ID}/metadata" \
                -H "Girder-Token: ${GIRDER_TOKEN}" \
                -H "Content-Type: application/json" \
                -d "$MERGED" > /dev/null

            info "  ✓ Metadata set on: $ITEM_NAME"
        fi
    done < <(echo "$ITEMS_JSON" | jq -c '.[]')
fi

# ── Step 7: Cleanup ───────────────────────────────────────────────────────────
info "Cleaning up temp files..."
rm -rf "$WORK_DIR"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  DONE"
echo "============================================"
echo "  Patient:      $PATIENT_NAME"
echo "  S3 path:      ${S3_DEST}"
echo "  Girder folder:${FOLDER_ID}"
echo "  Items:        $ITEM_COUNT"
echo "  Collection:   ${GIRDER_BASE}/collection/${COLLECTION_ID}"
echo "============================================"
