#!/usr/bin/env bash
# Build + push 4 mock images to ECR.
# (Weekend workaround - on weekdays this step moves into a CI/CD pipeline once
#  CodeStar Connection is available; the helm chart stays unchanged.)
#
# Usage:
#   AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build-all.sh           # build + push only
#   AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build-all.sh --deploy  # + helm upgrade
#
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"

MOCKS=(
  azure-entra-mock
  azure-logic-apps-mock
  gcp-vertex-mock
  gcp-bigquery-mock
)

cd "$(dirname "$0")"

# ECR repo bootstrap (idempotent)
for m in "${MOCKS[@]}"; do
  aws ecr describe-repositories --repository-names "bookflow/${m}" --region "${REGION}" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "bookflow/${m}" --region "${REGION}" >/dev/null
done

# ECR login
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR}"

# Build + push each
for m in "${MOCKS[@]}"; do
  echo "=== build ${m} ==="
  docker build \
    --build-arg "MOCK_DIR=${m}" \
    -t "${ECR}/bookflow/${m}:${TAG}" \
    -f Dockerfile .
  docker push "${ECR}/bookflow/${m}:${TAG}"
done

echo
echo "Images pushed: ${ECR}/bookflow/<mock>:${TAG}"

if [[ "${1:-}" == "--deploy" ]]; then
  echo
  echo "=== helm upgrade --install csp-mocks ==="
  helm upgrade --install csp-mocks ./charts/csp-mocks \
    --create-namespace \
    --set ecrRegistry="${ECR}" \
    --set imageTag="${TAG}"
  echo
  echo "Verify:"
  echo "  kubectl get pods -n stubs"
  echo "  kubectl get svc  -n stubs"
else
  echo
  echo "Skipped helm upgrade. Run with --deploy or:"
  echo "  helm upgrade --install csp-mocks ./charts/csp-mocks --create-namespace --set ecrRegistry=${ECR} --set imageTag=${TAG}"
fi
