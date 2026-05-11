# Publisher — 출판사 신간 요청 채널

출판사가 신간 요청서를 BookFlow 시스템에 제출하는 웹 애플리케이션.

---

## 아키텍처 (page 17 인프라 기반)

```
[출판사 브라우저]
        │ HTTPS (80 HTTP · 프로덕션은 ACM + 443)
        ▼
[External ALB]  ← WAFv2 (Rate limit · OWASP · IP Reputation)
 bookflow-alb-external  (Egress VPC 10.2.0.0/16 Public subnet)
        │ Listener :80 → PublisherBlueTg (CodeDeploy Blue/Green)
        ▼
[EC2 ASG]  t3.micro × 2  (Egress VPC Public AZ1/AZ2)
  ├── nginx :80
  │     ├── /          → /var/www/publisher/index.html  (프론트엔드)
  │     ├── /health    → 200 ok  (ALB 헬스체크)
  │     └── /api/      → proxy_pass uvicorn :8000  (FastAPI 백엔드)
  └── uvicorn :8000
        └── backend/main.py (FastAPI)
              │
              ├── S3 PUT (첨부파일)  ──→ bookflow-publisher-uploads 버킷
              │
              └── psycopg3 (sslmode=require)
                    │ Transit Gateway (60-network-cross-cloud/tgw.yaml)
                    ▼
              [RDS PostgreSQL 16]  (Data VPC 10.3.0.0/16 DB subnet)
                    ↑
[publisher-watcher CronJob]  (EKS, 매 1분)
  GET /api/v1/new-book-requests?status=NEW
  → books UPSERT + Redis pub/sub 알림
```

---

## ⚠️ 인프라 미비사항 (앱 배포 전 반드시 해결)

### 1. S3 버킷 없음 — 첨부파일 저장 버킷 미존재

**위치**: `BookFlowAI-Platform/infra/aws/00-foundation/s3.yaml`

현재 raw/mart/cp-artifacts/glue-scripts 버킷만 존재.
publisher 첨부파일(마케팅 자료, 원고 샘플)을 저장할 버킷이 없음.

**추가해야 할 리소스**:
```yaml
# s3.yaml 에 아래 버킷 추가
PublisherUploadsBucket:
  Type: AWS::S3::Bucket
  Properties:
    BucketName: !Sub '${ProjectName}-publisher-uploads-${AWS::AccountId}'
    VersioningConfiguration:
      Status: Enabled
    BucketEncryption:
      ServerSideEncryptionConfiguration:
        - ServerSideEncryptionByDefault:
            SSEAlgorithm: aws:kms
    PublicAccessBlockConfiguration:
      BlockPublicAcls: true
      BlockPublicPolicy: true
      IgnorePublicAcls: true
      RestrictPublicBuckets: true
    LifecycleConfiguration:
      Rules:
        - Id: ExpireUploads365d
          Status: Enabled
          ExpirationInDays: 365
```

---

### 2. Publisher EC2 IAM Role에 S3 PutObject 권한 없음

**위치**: `BookFlowAI-Platform/infra/aws/40-compute-runtime/publisher-asg.yaml`
→ `PublisherRole` → `Policies`

현재 CodeDeploy 아티팩트 S3 읽기(Get/List)만 허용.
EC2 에서 첨부파일을 publisher-uploads 버킷에 PUT 하려면 추가 필요.

**추가해야 할 Policy 항목**:
```yaml
- PolicyName: PublisherUploadsWrite
  PolicyDocument:
    Version: '2012-10-17'
    Statement:
      - Effect: Allow
        Action:
          - s3:PutObject
          - s3:GetObject   # 업로드 확인용
        Resource:
          - !Sub
            - arn:aws:s3:::${BucketName}/attachments/*
            - BucketName: !ImportValue
                Fn::Sub: ${ProjectName}-s3-publisher-uploads-name
```

---

### 3. publisher-watcher API URL 미설정

**위치**: `BookFlowAI-Platform/../eks-pods/publisher-watcher/k8s/configmap.yaml`

```yaml
PUBWATCH_PUBLISHER_API_URL: ""   # ← 현재 빈 값 (no-op cron)
```

publisher-api EC2 배포 후 ALB DNS 또는 Route53 도메인으로 업데이트:
```yaml
PUBWATCH_PUBLISHER_API_URL: "http://bookflow-alb-external-<hash>.ap-northeast-1.elb.amazonaws.com"
```

kubectl 로 즉시 적용:
```bash
kubectl -n bookflow edit configmap publisher-watcher-env
# 또는
kubectl -n bookflow patch configmap publisher-watcher-env \
  --patch '{"data":{"PUBWATCH_PUBLISHER_API_URL":"http://<ALB_DNS>"}}'
```

---

## 파일 구조

```
publisher/
├── appspec.yml                   # CodeDeploy Blue/Green 훅 정의
├── README.md
│
├── src/
│   └── index.html                # 출판사 전용 포털 UI (순수 HTML/CSS/JS · 빌드 불필요)
│
├── backend/                      # FastAPI 백엔드 패키지
│   ├── __init__.py
│   ├── main.py                   # FastAPI 앱 · 엔드포인트 정의
│   ├── settings.py               # pydantic-settings · /etc/publisher-api.env 로드
│   ├── db.py                     # psycopg3 ConnectionPool (RDS)
│   ├── storage.py                # boto3 S3 첨부파일 업로드
│   ├── auth.py                   # X-Api-Key SHA-256 검증
│   ├── models.py                 # Pydantic 요청/응답 모델
│   ├── requirements.txt          # Python 의존성
│   └── migration.sql             # RDS 스키마 확장 (배포 전 1회 실행)
│
└── scripts/                      # CodeDeploy 훅 셸 스크립트
    ├── before-install.sh         # nginx + Python 설치 · 이전 배포 백업
    ├── after-install.sh          # venv 설치 · Secrets Manager · systemd · nginx 설정
    └── validate-service.sh       # nginx + uvicorn 헬스체크
```

---

## API 엔드포인트

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| `GET` | `/health` | 없음 | nginx + ALB 헬스체크 |
| `POST` | `/api/v1/new-book-requests` | X-Api-Key | 신간 요청서 제출 (multipart/form-data) |
| `GET` | `/api/v1/new-book-requests` | 없음 | publisher-watcher 폴링용 (status=NEW 목록) |
| `GET` | `/api/v1/new-book-requests/{isbn13}/status` | X-Api-Key | 요청 처리 상태 조회 |

### POST 요청 필드

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `isbn13` | string | ✅ | ISBN-13 (13자리 숫자) |
| `publisher_id` | string | ✅ | 출판사 코드 |
| `title` | string | ✅ | 도서명 |
| `author` | string | ✅ | 저자명 |
| `genre` | string | - | 장르/카테고리 |
| `expected_pub_date` | string | - | 출판 예정일 YYYY-MM-DD |
| `estimated_initial_sales` | int | - | 예상 초판 판매량 |
| `marketing_plan` | string | - | 마케팅 계획 (최대 5000자) |
| `similar_books` | JSON string | - | 유사 도서 ISBN13 배열 |
| `target_segments` | JSON string | - | 독자 세그먼트 배열 |
| `attachment` | file | - | PDF/Word/이미지, 최대 10MB |

---

## 배포 절차

### 1. 인프라 미비사항 해결 (위 ⚠️ 참조)

```bash
# s3.yaml 스택 업데이트
aws cloudformation update-stack --stack-name bookflow-00-s3 --template-body file://s3.yaml

# publisher-asg.yaml 스택 업데이트 (IAM 권한 추가)
aws cloudformation update-stack --stack-name bookflow-40-publisher-asg --template-body file://publisher-asg.yaml
```

### 2. Secrets Manager 시크릿 생성

```bash
aws secretsmanager create-secret \
  --name bookflow/publisher-api \
  --secret-string '{
    "RDS_HOST": "<RDS 엔드포인트>",
    "RDS_PORT": "5432",
    "RDS_DB": "bookflow",
    "RDS_USER": "publisher_api",
    "RDS_PASSWORD": "<비밀번호>",
    "S3_BUCKET": "bookflow-publisher-uploads-<account-id>",
    "S3_PREFIX": "attachments/",
    "AWS_REGION": "ap-northeast-1",
    "API_KEY_HASH": "<echo -n 발급키 | sha256sum>",
    "LOG_LEVEL": "INFO"
  }'
```

### 3. DB 마이그레이션 실행 (Ansible Control Node 에서)

```bash
# psql 로 RDS 에 접속 (Transit Gateway 경유)
psql -h <RDS_HOST> -U master -d bookflow -f publisher/backend/migration.sql
```

### 4. CodeDeploy 배포 (GitHub Actions OIDC)

```bash
# GHA 워크플로우 트리거 (main 브랜치 push 또는 수동)
gh workflow run deploy-publisher.yml
```

### 5. publisher-watcher configmap 업데이트 (위 ⚠️ 3번 참조)

```bash
kubectl -n bookflow patch configmap publisher-watcher-env \
  --patch '{"data":{"PUBWATCH_PUBLISHER_API_URL":"http://<ALB_DNS>"}}'
```

---

## 로컬 개발 실행

### 사전 요구사항

- Python 3.12+
- PostgreSQL 16 (또는 포트 포워딩으로 RDS 접근)

### 백엔드 실행

```bash
cd publisher/backend

# 의존성 설치
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 환경변수 설정 (개발용)
export RDS_HOST=localhost
export RDS_PORT=5432
export RDS_DB=bookflow
export RDS_USER=publisher_api
export RDS_PASSWORD=localpass
export S3_BUCKET=dev-bucket
export AWS_REGION=ap-northeast-1
export API_KEY_HASH=   # 빈 값 = 인증 우회 (dev mode)

# DB 마이그레이션 (최초 1회)
psql -U publisher_api -d bookflow -f migration.sql

# 서버 시작 (루트 디렉토리에서 실행)
cd ..
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

### 프론트엔드 실행

별도 빌드 불필요. 브라우저로 직접 열거나 nginx 로 서빙:

```bash
# 간단히 확인
python3 -m http.server 3000 --directory src/
# → http://localhost:3000  (API 는 /api/ 프록시 설정 필요)
```

프론트↔백엔드 함께 사용 시:
```nginx
# 개발용 nginx.conf
location /api/ { proxy_pass http://127.0.0.1:8000; }
location /     { root /path/to/publisher/src; }
```

### API 직접 테스트

```bash
# API 키 해시 생성
API_KEY="test-key-1234"
API_KEY_HASH=$(echo -n "$API_KEY" | sha256sum | cut -d' ' -f1)

# 신간 요청서 제출
curl -X POST http://localhost:8000/api/v1/new-book-requests \
  -H "X-Api-Key: $API_KEY" \
  -F "isbn13=9791234567890" \
  -F "publisher_id=PUB-001" \
  -F "title=테스트 도서" \
  -F "author=홍길동" \
  -F "genre=소설/문학" \
  -F "estimated_initial_sales=1000" \
  -F "similar_books=[\"9790000000001\"]" \
  -F "target_segments=[\"20대\",\"직장인\"]"

# 상태 조회
curl http://localhost:8000/api/v1/new-book-requests/9791234567890/status \
  -H "X-Api-Key: $API_KEY"

# publisher-watcher 폴링 (인증 없음)
curl "http://localhost:8000/api/v1/new-book-requests?status=NEW"
```
