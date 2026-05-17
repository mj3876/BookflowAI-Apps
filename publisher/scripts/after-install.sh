#!/usr/bin/env bash
# CodeDeploy AfterInstall Hook
# 역할:
#   1. Python venv 생성 + requirements.txt 설치
#   2. Secrets Manager 에서 환경변수 파일 생성 (/etc/publisher-api.env)
#   3. DB 마이그레이션 실행 (migration.sql — idempotent)
#   4. systemd publisher-api.service 등록 + 시작
#   5. nginx 설정 갱신 (정적 파일 서빙 + /api/ → uvicorn :8000 프록시)
set -Eeuo pipefail

APP_DIR="/var/www/publisher"
VENV="$APP_DIR/venv"
NGINX_SITE="/etc/nginx/sites-available/bookflow-publisher"
NGINX_LINK="/etc/nginx/sites-enabled/bookflow-publisher"
ENV_FILE="/etc/publisher-api.env"
SERVICE_NAME="publisher-api"
LOG_FILE="/var/log/bookflow-publisher-deploy.log"

exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== AfterInstall started at $(date -Is) ==="

# ── 1. 앱 디렉토리 권한 설정 ──────────────────────────────────────────────────
chown -R www-data:www-data "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +
# 스크립트 실행 권한
chmod +x "$APP_DIR"/scripts/*.sh 2>/dev/null || true

# ── 2. Python venv + 의존성 설치 ──────────────────────────────────────────────
# venv 가 없거나 requirements.txt 가 변경된 경우 재설치
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$APP_DIR/backend/requirements.txt"

# ── 3. Secrets Manager 에서 환경변수 파일 생성 ────────────────────────────────
# EC2 IAM Role (publisher-asg.yaml PublisherRole) 의 secretsmanager:GetSecretValue 로 읽음.
# Secret 명: bookflow/publisher-api  (인프라 미비: Secrets Manager 에 수동 생성 필요)
# Secret 내용 예시 (JSON):
# {
#   "RDS_HOST": "bookflow-postgres.xxxxxx.ap-northeast-1.rds.amazonaws.com",
#   "RDS_PORT": "5432",
#   "RDS_DB": "bookflow",
#   "RDS_USER": "publisher_api",
#   "RDS_PASSWORD": "...",
#   "S3_BUCKET": "bookflow-publisher-uploads-<account-id>",
#   "S3_PREFIX": "attachments/",
#   "AWS_REGION": "ap-northeast-1",
#   "API_KEY_HASH": "<sha256 hex>",
#   "LOG_LEVEL": "INFO"
# }
SECRET_NAME="bookflow/publisher-api"
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --query SecretString \
  --output text 2>/dev/null || true)
if [ -n "$SECRET_JSON" ]; then
  echo "$SECRET_JSON" | "$VENV/bin/python3" -c "
import sys, json
d = json.load(sys.stdin)
for k, v in d.items():
    print(f'{k.upper()}={v}')
" > "$ENV_FILE"
  chown root:www-data "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "Loaded secrets from Secrets Manager: $SECRET_NAME"
else
  # Secrets Manager 미설정 시 개발용 기본값 (프로덕션 절대 사용 금지)
  echo "WARNING: $SECRET_NAME not found — using dev defaults (NO REAL DB/AUTH)"
  cat > "$ENV_FILE" <<'ENVEOF'
RDS_HOST=localhost
RDS_PORT=5432
RDS_DB=bookflow
RDS_USER=publisher_api
RDS_PASSWORD=changeme
S3_BUCKET=bookflow-publisher-uploads
S3_PREFIX=attachments/
AWS_REGION=ap-northeast-1
API_KEY_HASH=
LOG_LEVEL=INFO
ENVEOF
  chown root:www-data "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

# ── 3-b. RDS_HOST 라이브 보정 ─────────────────────────────────────────────────
# RDS 는 매일 destroy/recreate 되어 엔드포인트 hash 가 바뀐다. secret 의 정적
# RDS_HOST 값 대신 CFN 스택(bookflow-20-rds) 출력에서 현재 엔드포인트를 조회해 덮어쓴다.
# → 매 배포 / 인스턴스 기동 시 항상 현재 RDS 를 가리킴 (daily 재생성에도 안 깨짐).
RDS_HOST_LIVE=$(aws cloudformation describe-stacks \
  --stack-name bookflow-20-rds \
  --query "Stacks[0].Outputs[?OutputKey=='DbEndpointAddress'].OutputValue | [0]" \
  --output text 2>/dev/null || true)
if [ -n "$RDS_HOST_LIVE" ] && [ "$RDS_HOST_LIVE" != "None" ]; then
  sed -i "s|^RDS_HOST=.*|RDS_HOST=${RDS_HOST_LIVE}|" "$ENV_FILE"
  echo "RDS_HOST resolved live from CFN bookflow-20-rds: $RDS_HOST_LIVE"
else
  echo "WARNING: RDS_HOST 를 CFN 에서 조회 못함 — secret/기본값 그대로 사용"
fi

# ── 4. DB 마이그레이션 (migration.sql — ADD COLUMN IF NOT EXISTS) ──────────────
# EC2 (Egress VPC) → Transit Gateway → RDS (Data VPC) 경로로 연결
# 연결 실패 시 경고만 출력하고 계속 진행 (앱은 기동하되 DB 요청 시 오류)
if [ -f "$APP_DIR/backend/migration.sql" ]; then
  set -a; source "$ENV_FILE"; set +a
  if "$VENV/bin/python3" -c "
import psycopg, sys, os
try:
    conn = psycopg.connect(
        host=os.environ['RDS_HOST'],
        port=os.environ.get('RDS_PORT', '5432'),
        dbname=os.environ.get('RDS_DB', 'bookflow'),
        user=os.environ['RDS_USER'],
        password=os.environ['RDS_PASSWORD'],
        sslmode='require',
        connect_timeout=5
    )
    with open('$APP_DIR/backend/migration.sql') as f:
        conn.execute(f.read())
    conn.commit()
    conn.close()
    print('migration.sql applied')
except Exception as e:
    print(f'migration skipped: {e}', file=sys.stderr)
    sys.exit(0)
" 2>&1; then
    echo "DB migration completed"
  else
    echo "WARNING: DB migration could not run — check RDS connectivity and credentials"
  fi
fi

# ── 5. systemd 서비스 등록 (uvicorn 으로 FastAPI 실행) ────────────────────────
# uvicorn 은 127.0.0.1:8000 에서 대기 → nginx 가 /api/ 를 프록시
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=BookFlow Publisher API (FastAPI/uvicorn)
Documentation=https://github.com/MyosoonHwang/BookFlowAI-Apps
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${APP_DIR}
# backend 패키지를 모듈로 실행 (relative import 정합)
ExecStart=${VENV}/bin/uvicorn backend.main:app \\
    --host 127.0.0.1 \\
    --port 8000 \\
    --workers 2 \\
    --log-level info \\
    --access-log
EnvironmentFile=${ENV_FILE}
Restart=always
RestartSec=5
# EC2 t3.micro 메모리 제한 (2 workers × ~80MB)
MemoryMax=256M

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── 6. nginx 설정 (정적 파일 + /api/ 프록시) ──────────────────────────────────
# 기존 트래픽 흐름:
#   인터넷 → ALB (50-network-traffic/alb-external.yaml) → EC2 :80 → nginx
# nginx 역할:
#   /           → /var/www/publisher/index.html (프론트엔드 SPA)
#   /api/       → 127.0.0.1:8000 (FastAPI uvicorn) — 신규
#   /health     → 200 ok (ALB 헬스체크)
cat > "$NGINX_SITE" <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/publisher;
    index index.html;

    access_log /var/log/nginx/bookflow-publisher-access.log;
    error_log  /var/log/nginx/bookflow-publisher-error.log warn;

    # ALB 헬스체크 (alb-external.yaml HealthCheckPath: "/" 로 설정되어 있어
    # 별도 /health 경로 외 "/" 자체도 200 반환하면 정상 — try_files 가 처리)
    location = /health {
        access_log off;
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }

    # FastAPI 백엔드 프록시
    # publisher-watcher 폴링: GET /api/v1/new-book-requests
    # 출판사 제출:           POST /api/v1/new-book-requests
    # 상태 조회:             GET /api/v1/new-book-requests/{isbn}/status
    location /api/ {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # 첨부파일 업로드 허용 크기 (backend storage.py MAX_FILE_SIZE_BYTES=10MB 와 정합)
        client_max_body_size 11M;
        proxy_read_timeout 60s;
    }

    # 프론트엔드 SPA (React 미사용 · 단일 index.html)
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sfn "$NGINX_SITE" "$NGINX_LINK"
nginx -t
systemctl restart nginx

echo "AfterInstall completed at $(date -Is)"
