#!/bin/bash
# =============================================================================
# pipeline_wsi.sh  —  Generic WSI pipeline: Pramana NAS → S3 → Girder (EC2)
#
# Usage:
#   ./pipeline_wsi.sh <config_file> [--once | --folder <SLIDE_ID> | --watch]
#
# Examples:
#   ./pipeline_wsi.sh configs/nssh.conf --once
#   ./pipeline_wsi.sh configs/bmjh.conf --folder C02N25TB190P-7363
#   ./pipeline_wsi.sh configs/mda.conf  --watch
#
# Config files live in: scripts/configs/<org>.conf
# Processed-slides log: per-org, defined in config (DONE_LOG)
# =============================================================================

set -euo pipefail

# ── Arg parsing ───────────────────────────────────────────────────────────────
CONFIG_FILE="${1:-}"
MODE="${2:---once}"
SINGLE_SLIDE="${3:-}"

if [ -z "$CONFIG_FILE" ] || [ ! -f "$CONFIG_FILE" ]; then
    echo "Usage: $0 <config_file> [--once | --watch | --folder <SLIDE_ID>]"
    echo ""
    echo "Available configs:"
    ls -1 "$(dirname "$0")/configs/"*.conf 2>/dev/null | sed 's/.*\//  /' || echo "  (none found)"
    exit 1
fi

# ── Load config ───────────────────────────────────────────────────────────────
# shellcheck source=/dev/null
source "$CONFIG_FILE"

# ── Validate required config vars ─────────────────────────────────────────────
for var in SOURCE_DIR S3_BUCKET S3_PREFIX AWS_PROFILE \
           EC2_HOST EC2_USER EC2_KEY EC2_IMPORT_SCRIPT \
           GIRDER_USER GIRDER_PASS DEST_FOLDER_ID ASSETSTORE_ID; do
    [ -z "${!var:-}" ] && { echo "[ERROR] Config missing: $var (in $CONFIG_FILE)"; exit 1; }
done

WORK_DIR="${WORK_DIR:-/tmp/wsi_extract}"
DIST_DIR="${DIST_DIR:-/tmp/wsi_dist}"
DONE_LOG="${DONE_LOG:-/var/log/pathassist_imported_${ORG_NAME:-default}.log}"
LOG_FILE="${LOG_FILE:-/var/log/pathassist_pipeline_${ORG_NAME:-default}.log}"

# ── Logging ───────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$DONE_LOG")" "$(dirname "$LOG_FILE")" 2>/dev/null || true
touch "$DONE_LOG"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ts() { date '+%Y-%m-%d %H:%M:%S'; }
info()  { echo -e "$(ts) ${GREEN}[INFO]${NC}  $*" | tee -a "$LOG_FILE"; }
warn()  { echo -e "$(ts) ${YELLOW}[WARN]${NC}  $*" | tee -a "$LOG_FILE"; }
error() { echo -e "$(ts) ${RED}[ERROR]${NC} $*" | tee -a "$LOG_FILE"; exit 1; }
step()  { echo -e "$(ts) ${CYAN}[STEP]${NC}  $*" | tee -a "$LOG_FILE"; }

info "=========================================="
info " ORG:    ${ORG_NAME:-unknown}"
info " Config: $CONFIG_FILE"
info " Mode:   $MODE ${SINGLE_SLIDE}"
info "=========================================="

# ── Helpers ───────────────────────────────────────────────────────────────────
already_done() { grep -qxF "$1" "$DONE_LOG" 2>/dev/null; }
mark_done()    { echo "$1" >> "$DONE_LOG"; }

# ── Process one slide ─────────────────────────────────────────────────────────
process_slide() {
    local SLIDE_ID="$1"
    local SLIDE_DIR="${SOURCE_DIR}/${SLIDE_ID}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    step "Processing: $SLIDE_ID  [org: ${ORG_NAME:-?}]"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # ── Extract ───────────────────────────────────────────────────────────────
    local WORK="${WORK_DIR}/${ORG_NAME:-default}/${SLIDE_ID}"
    rm -rf "$WORK" && mkdir -p "$WORK"

    local ZIP_FILE="${SLIDE_DIR}/${SLIDE_ID}.zip"
    local TAR_FILE="${SLIDE_DIR}/other.tar"

    if [ -f "$ZIP_FILE" ]; then
        step "Extracting ZIP..."
        unzip -q "$ZIP_FILE" -d "$WORK"
    else
        warn "ZIP not found: $ZIP_FILE"
    fi

    if [ -f "$TAR_FILE" ]; then
        step "Extracting TAR..."
        tar -xf "$TAR_FILE" -C "$WORK"
    else
        warn "TAR not found: $TAR_FILE"
    fi

    # ── Stage files ───────────────────────────────────────────────────────────
    local DEST="${DIST_DIR}/${ORG_NAME:-default}/${SLIDE_ID}"
    mkdir -p "$DEST"

    local OME_TIFF
    OME_TIFF=$(find "$WORK" \( -name "*.ome.tiff" -o -name "*.ome.tif" \) 2>/dev/null | head -1)

    local LOC="${WORK}/loc_output_data"

    [ -n "$OME_TIFF" ] && [ -f "$OME_TIFF" ] \
        && cp "$OME_TIFF" "$DEST/" \
        && info "  ✓ OME-TIFF: $(basename "$OME_TIFF")" \
        || warn "  OME-TIFF not found"

    [ -f "${LOC}/barcodeImage.jpeg" ] \
        && cp "${LOC}/barcodeImage.jpeg" "$DEST/" \
        && info "  ✓ barcodeImage.jpeg"

    if [ -f "${LOC}/whiteCorrectedInput.jpeg" ]; then
        cp "${LOC}/whiteCorrectedInput.jpeg" "$DEST/" && info "  ✓ whiteCorrectedInput.jpeg"
    elif [ -f "${LOC}/macro_for_post_processing.png" ]; then
        cp "${LOC}/macro_for_post_processing.png" "$DEST/whiteCorrectedInput.jpeg" \
            && info "  ✓ macro (from macro_for_post_processing.png)"
    fi

    [ -f "${LOC}/${SLIDE_ID}.jpeg" ] \
        && cp "${LOC}/${SLIDE_ID}.jpeg" "$DEST/" \
        && info "  ✓ thumbnail: ${SLIDE_ID}.jpeg"

    # metadata.json — try loc_output_data first, then slide subfolder
    local META=""
    [ -f "${LOC}/metadata.json" ]                 && META="${LOC}/metadata.json"
    [ -z "$META" ] && [ -f "${WORK}/${SLIDE_ID}/metadata.json" ] \
                                                  && META="${WORK}/${SLIDE_ID}/metadata.json"
    [ -n "$META" ] && cp "$META" "$DEST/metadata.json" && info "  ✓ metadata.json"

    info "Staged files:"
    ls -lh "$DEST"

    # ── Upload to S3 ──────────────────────────────────────────────────────────
    local S3_DEST="s3://${S3_BUCKET}/${S3_PREFIX}/${SLIDE_ID}/"
    step "Uploading to ${S3_DEST}"

    aws s3 cp "$DEST" "$S3_DEST" \
        --recursive \
        --profile "$AWS_PROFILE" \
        --only-show-errors

    info "S3 upload complete ✓"

    # ── Trigger Girder import on EC2 ──────────────────────────────────────────
    step "Triggering Girder import on EC2..."

    ssh -i "$EC2_KEY" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=30 \
        "${EC2_USER}@${EC2_HOST}" \
        "GIRDER_USER=${GIRDER_USER} \
         GIRDER_PASS=${GIRDER_PASS} \
         SINGLE_SLIDE=${SLIDE_ID} \
         DEST_FOLDER_ID=${DEST_FOLDER_ID} \
         ASSETSTORE_ID=${ASSETSTORE_ID} \
         S3_PREFIX=${S3_PREFIX} \
         bash ${EC2_IMPORT_SCRIPT}"

    info "Girder import complete ✓"

    # ── Cleanup ───────────────────────────────────────────────────────────────
    rm -rf "$WORK" "$DEST"
    mark_done "$SLIDE_ID"
    info "Done: $SLIDE_ID ✓"
}

# ── Scan all new folders ──────────────────────────────────────────────────────
scan_new_slides() {
    local count=0
    while IFS= read -r -d '' dir; do
        local slide_id
        slide_id=$(basename "$dir")
        [ -f "${dir}/${slide_id}.zip" ] || [ -f "${dir}/other.tar" ] || continue
        already_done "$slide_id" && continue
        process_slide "$slide_id"
        count=$((count + 1))
    done < <(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
    [ "$count" -eq 0 ] && info "No new slides found."
}

# ── Entry point ───────────────────────────────────────────────────────────────
case "$MODE" in
    --folder)
        [ -z "$SINGLE_SLIDE" ] && error "Usage: $0 <config> --folder <SLIDE_ID>"
        process_slide "$SINGLE_SLIDE"
        ;;
    --once)
        scan_new_slides
        ;;
    --watch)
        command -v inotifywait &>/dev/null \
            || error "inotifywait not found. Run: sudo apt-get install -y inotify-tools"
        info "Watch mode: monitoring $SOURCE_DIR ..."
        scan_new_slides   # handle backlog first
        inotifywait -m -e create -e moved_to --format '%f' "$SOURCE_DIR" 2>/dev/null | \
        while read -r SLIDE_ID; do
            [ -d "${SOURCE_DIR}/${SLIDE_ID}" ] || continue
            already_done "$SLIDE_ID" && continue
            info "New folder detected: $SLIDE_ID — waiting 60s for scan to finish writing..."
            sleep 60
            process_slide "$SLIDE_ID" || warn "Failed: $SLIDE_ID"
        done
        ;;
    *)
        error "Unknown mode: $MODE. Use --once | --watch | --folder <ID>"
        ;;
esac
