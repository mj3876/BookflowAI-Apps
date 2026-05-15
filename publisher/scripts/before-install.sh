#!/usr/bin/env bash
# CodeDeploy BeforeInstall Hook
# 역할: 이전 배포본 백업 + 앱 디렉토리 초기화 + 런타임(nginx, Python) 설치
set -Eeuo pipefail

APP_DIR="/var/www/publisher"
BACKUP_DIR="/var/www/publisher.previous"
LOG_FILE="/var/log/bookflow-publisher-deploy.log"

exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== BeforeInstall started at $(date -Is) ==="

export DEBIAN_FRONTEND=noninteractive

# ── nginx 설치 (최초 1회만) ────────────────────────────────────────────────────
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y --no-install-recommends nginx ca-certificates curl
fi
systemctl enable nginx

# ── Python 3 + pip + venv 설치 (FastAPI 백엔드 런타임) ────────────────────────
# Ubuntu 24.04 는 python3 기본 설치되어 있으나 venv/pip 는 별도 설치 필요
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-venv python3.12-venv \
  libpq-dev gcc unzip

# AWS CLI v2 (Secrets Manager 읽기용 · Ubuntu 24.04 는 apt 에 awscli 없음)
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  apt-get install -y --no-install-recommends unzip
  unzip -q /tmp/awscliv2.zip -d /tmp/awscli-install
  /tmp/awscli-install/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/awscli-install
fi

# ── 이전 배포본 백업 ───────────────────────────────────────────────────────────
rm -rf "$BACKUP_DIR"
if [ -d "$APP_DIR" ]; then
  # venv 는 크기가 크므로 백업에서 제외
  rsync -a --exclude='venv/' "$APP_DIR/" "$BACKUP_DIR/"
fi

# ── 앱 디렉토리 초기화 (venv 제외) ────────────────────────────────────────────
install -d -m 0755 "$APP_DIR"
# venv 는 재사용 (재설치 속도를 위해 삭제하지 않음)
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'venv' -exec rm -rf {} +

echo "BeforeInstall completed at $(date -Is)"
