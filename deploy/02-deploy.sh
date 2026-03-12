#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy/02-deploy.sh
# Run this every time you want to release a new version of the UI.
# Usage:
#   ./deploy/02-deploy.sh              # production build + deploy
#   ./deploy/02-deploy.sh --dry-run    # see what would be uploaded, no changes
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config — fill these in after running 01-setup-infrastructure.sh ──────────
BUCKET_NAME="pathassist-ui"
CLOUDFRONT_ID="E1W8U5RM58YBYN"
# ─────────────────────────────────────────────────────────────────────────────

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "⚠  DRY RUN — no files will be uploaded or invalidated"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> [1/4] Installing dependencies"
cd "$ROOT_DIR"
npm ci --silent

echo "==> [2/4] Building production bundle"
npm run build

BUILD_SIZE=$(du -sh dist/ | cut -f1)
FILE_COUNT=$(find dist/ -type f | wc -l | tr -d ' ')
echo "    Built: $FILE_COUNT files, $BUILD_SIZE total"

if [ "$DRY_RUN" = true ]; then
  echo "==> [3/4] DRY RUN — files that would be uploaded:"
  aws s3 sync dist/ "s3://$BUCKET_NAME/" --dryrun
  echo "==> [4/4] DRY RUN — skipping CloudFront invalidation"
  exit 0
fi

echo "==> [3/4] Syncing to S3"

# index.html — no cache (always fetch fresh so users get latest version)
aws s3 cp dist/index.html "s3://$BUCKET_NAME/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html"

# Hashed JS/CSS/assets — immutable cache (Vite adds content hashes to filenames)
aws s3 sync dist/ "s3://$BUCKET_NAME/" \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable" \
  --delete   # remove files from S3 that no longer exist in dist/

echo "==> [4/4] Invalidating CloudFront cache for index.html"
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_ID" \
  --paths "/index.html" \
  --query 'Invalidation.Id' --output text)

echo "    Invalidation ID: $INVALIDATION_ID (propagates in ~30-60 seconds)"
echo ""
echo "  Deploy complete!"
echo "  CloudFront will serve the new version within ~1 minute."
