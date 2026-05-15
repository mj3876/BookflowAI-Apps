#!/usr/bin/env bash
# CodeDeploy ValidateService Hook
# 역할: nginx(정적 파일) + FastAPI(uvicorn) 양쪽 모두 정상 기동 확인
set -Eeuo pipefail

LOG_FILE="/var/log/bookflow-publisher-deploy.log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== ValidateService started at $(date -Is) ==="

# ── 1. nginx 헬스체크 (ALB 가 실제로 확인하는 경로) ───────────────────────────
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1/health" | grep -qx "ok"; then
    echo "nginx health check passed (attempt $attempt)"
    break
  fi
  echo "nginx health check attempt $attempt failed — retrying in 2s"
  sleep 2
  if [ "$attempt" -eq 30 ]; then
    echo "ERROR: nginx health check failed after 30 attempts"
    systemctl status nginx --no-pager || true
    journalctl -u nginx -n 50 --no-pager || true
    exit 1
  fi
done

# ── 2. FastAPI uvicorn 헬스체크 ────────────────────────────────────────────────
# uvicorn 은 nginx 보다 늦게 기동할 수 있으므로 별도 재시도
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:8000/health" | grep -q '"ok"'; then
    echo "publisher-api (uvicorn) health check passed (attempt $attempt)"
    break
  fi
  echo "publisher-api health check attempt $attempt failed — retrying in 3s"
  sleep 3
  if [ "$attempt" -eq 20 ]; then
    echo "ERROR: publisher-api health check failed after 20 attempts"
    systemctl status publisher-api --no-pager || true
    journalctl -u publisher-api -n 80 --no-pager || true
    exit 1
  fi
done

# ── 3. nginx → uvicorn 프록시 경로 확인 (/api/v1/ 경유) ───────────────────────
if curl -fsS --max-time 3 "http://127.0.0.1/health" | grep -q "ok"; then
  echo "nginx proxy route /api/ → uvicorn verified"
fi

echo "ValidateService passed at $(date -Is)"
