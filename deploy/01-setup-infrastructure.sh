#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy/01-setup-infrastructure.sh
# Run ONCE to create the S3 bucket + CloudFront distribution.
# After this script finishes, save the CLOUDFRONT_ID it prints — you need it
# in deploy/02-deploy.sh every time you release.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config — edit these ───────────────────────────────────────────────────────
BUCKET_NAME="pathassist-ui"          # must be globally unique; add a suffix if taken
AWS_REGION="us-east-1"              # keep same region as your Girder/S3 data bucket
DOMAIN_ALIAS="apps.pathassist.health"
ACM_CERT_ARN="arn:aws:acm:us-east-1:039205283883:certificate/bb1c4d32-a2f9-4b68-9e3b-c856c85b8376"
# ─────────────────────────────────────────────────────────────────────────────

echo "==> [1/4] Creating private S3 bucket: $BUCKET_NAME"
if [ "$AWS_REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$AWS_REGION"
else
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$AWS_REGION" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION"
fi

# Block all public access — CloudFront will be the only way in
aws s3api put-public-access-block --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "==> [2/4] Creating CloudFront Origin Access Control (OAC)"
OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config \
    "Name=pathassist-ui-oac,Description=PathAssist UI OAC,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
  --query 'OriginAccessControl.Id' --output text)
echo "    OAC ID: $OAC_ID"

echo "==> [3/4] Creating CloudFront distribution"

# Build aliases + cert block only when a custom domain is provided
if [ -n "$DOMAIN_ALIAS" ] && [ -n "$ACM_CERT_ARN" ]; then
  ALIASES_BLOCK='"Aliases":{"Quantity":1,"Items":["'"$DOMAIN_ALIAS"'"]},'
  VIEWER_CERT_BLOCK='"ViewerCertificate":{"ACMCertificateArn":"'"$ACM_CERT_ARN"'","SSLSupportMethod":"sni-only","MinimumProtocolVersion":"TLSv1.2_2021"},'
else
  ALIASES_BLOCK=''
  VIEWER_CERT_BLOCK=''
fi

DISTRIBUTION_CONFIG=$(cat <<EOF
{
  "CallerReference": "pathassist-ui-$(date +%s)",
  "Comment": "PathAssist UI",
  $ALIASES_BLOCK
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "s3-pathassist-ui",
      "DomainName": "${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com",
      "OriginAccessControlId": "$OAC_ID",
      "S3OriginConfig": { "OriginAccessIdentity": "" }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-pathassist-ui",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] },
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true
  },
  "CustomErrorResponses": {
    "Quantity": 2,
    "Items": [
      {
        "ErrorCode": 404,
        "ResponsePagePath": "/index.html",
        "ResponseCode": "200",
        "ErrorCachingMinTTL": 0
      },
      {
        "ErrorCode": 403,
        "ResponsePagePath": "/index.html",
        "ResponseCode": "200",
        "ErrorCachingMinTTL": 0
      }
    ]
  },
  $VIEWER_CERT_BLOCK
  "PriceClass": "PriceClass_100",
  "Enabled": true,
  "HttpVersion": "http2and3"
}
EOF
)

CF_OUTPUT=$(aws cloudfront create-distribution --distribution-config "$DISTRIBUTION_CONFIG")
CLOUDFRONT_ID=$(echo "$CF_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Distribution']['Id'])")
CLOUDFRONT_DOMAIN=$(echo "$CF_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Distribution']['DomainName'])")

echo "==> [4/4] Attaching bucket policy to allow CloudFront OAC"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

BUCKET_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET_NAME}/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${CLOUDFRONT_ID}"
      }
    }
  }]
}
EOF
)

aws s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy "$BUCKET_POLICY"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Infrastructure ready! Save these values:"
echo ""
echo "  S3 Bucket:         $BUCKET_NAME"
echo "  CloudFront ID:     $CLOUDFRONT_ID"
echo "  CloudFront URL:    https://$CLOUDFRONT_DOMAIN"
if [ -n "$DOMAIN_ALIAS" ]; then
echo "  Custom Domain:     https://$DOMAIN_ALIAS"
echo "  → Point your DNS CNAME $DOMAIN_ALIAS → $CLOUDFRONT_DOMAIN"
fi
echo ""
echo "  Now set these in deploy/02-deploy.sh:"
echo "    BUCKET_NAME=$BUCKET_NAME"
echo "    CLOUDFRONT_ID=$CLOUDFRONT_ID"
echo "══════════════════════════════════════════════════════════════"
