#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${AMI_ID:?AMI_ID is required}"
: "${SUBNET_ID:?SUBNET_ID is required}"
: "${SECURITY_GROUP_ID:?SECURITY_GROUP_ID is required}"

INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
KEY_NAME="${KEY_NAME:-}"
IAM_INSTANCE_PROFILE="${IAM_INSTANCE_PROFILE:-}"
SPOT_PRICE="${SPOT_PRICE:-1.20}"
TAG_NAME="${TAG_NAME:-PathAssistModel-GPU}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-}"

USER_DATA=$(cat <<EOF
#!/bin/bash
set -euxo pipefail
mkdir -p /opt/pathassist-model
if [ -n "${BOOTSTRAP_URL}" ]; then
  curl -fsSL "${BOOTSTRAP_URL}" -o /tmp/bootstrap_gpu.sh
  chmod +x /tmp/bootstrap_gpu.sh
  /tmp/bootstrap_gpu.sh
fi
EOF
)

ARGS=(
  --region "$AWS_REGION"
  --instance-market-options "MarketType=spot,SpotOptions={MaxPrice=${SPOT_PRICE},SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}"
  --image-id "$AMI_ID"
  --instance-type "$INSTANCE_TYPE"
  --subnet-id "$SUBNET_ID"
  --security-group-ids "$SECURITY_GROUP_ID"
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${TAG_NAME}}]"
  --user-data "$USER_DATA"
  --count 1
)

if [ -n "$KEY_NAME" ]; then
  ARGS+=(--key-name "$KEY_NAME")
fi

if [ -n "$IAM_INSTANCE_PROFILE" ]; then
  ARGS+=(--iam-instance-profile "Name=${IAM_INSTANCE_PROFILE}")
fi

aws ec2 run-instances "${ARGS[@]}"
