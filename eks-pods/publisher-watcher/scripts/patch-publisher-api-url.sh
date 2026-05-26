#!/usr/bin/env bash
# publisher-watcher ConfigMap 에 출판사 ALB URL 을 동적으로 주입합니다.
# ALB 이름으로 DNS 를 조회하므로 URL 을 하드코딩하지 않습니다.
# 사용법: bash patch-publisher-api-url.sh [--region ap-northeast-1]
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
ALB_NAME="bookflow-alb-external"
NAMESPACE="bookflow"
CONFIGMAP="publisher-watcher-env"

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --region "$REGION" \
  --query "LoadBalancers[?LoadBalancerName=='${ALB_NAME}'].DNSName" \
  --output text)

if [ -z "$ALB_DNS" ]; then
  echo "ERROR: ALB '${ALB_NAME}' 를 찾을 수 없습니다." >&2
  exit 1
fi

PUBLISHER_API_URL="http://${ALB_DNS}/api/v1"
echo "ALB DNS: ${ALB_DNS}"
echo "PUBWATCH_PUBLISHER_API_URL → ${PUBLISHER_API_URL}"

kubectl patch configmap "$CONFIGMAP" -n "$NAMESPACE" \
  --patch "{\"data\":{\"PUBWATCH_PUBLISHER_API_URL\":\"${PUBLISHER_API_URL}\"}}"

echo "ConfigMap 업데이트 완료."
echo "다음 CronJob 실행(1분 이내)부터 출판사 API 폴링이 시작됩니다."
