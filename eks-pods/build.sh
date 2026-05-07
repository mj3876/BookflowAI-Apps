#!/usr/bin/env bash
# Build + push EKS Pod images. Auto-discovers any subdir with a Dockerfile.
#
# Usage:
#   AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build.sh                 # all pods
#   AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build.sh inventory-svc   # specific
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"

cd "$(dirname "$0")"

if [[ $# -gt 0 ]]; then
  PODS=("$@")
else
  mapfile -t PODS < <(find . -mindepth 2 -maxdepth 2 -name Dockerfile -exec dirname {} \; | sed 's|^\./||' | sort)
fi

for p in "${PODS[@]}"; do
  aws ecr describe-repositories --repository-names "bookflow/${p}" --region "${REGION}" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "bookflow/${p}" --region "${REGION}" >/dev/null
done

aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR}"

for p in "${PODS[@]}"; do
  echo "=== build ${p} ==="
  docker build -t "${ECR}/bookflow/${p}:${TAG}" -f "${p}/Dockerfile" "${p}"
  docker push "${ECR}/bookflow/${p}:${TAG}"
done

echo
echo "Images: ${ECR}/bookflow/<pod>:${TAG}"
