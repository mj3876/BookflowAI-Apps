# Glue ETL Jobs

BookFlow AI 플랫폼의 AWS Glue ETL 파이프라인 스크립트 모음.  
Step Functions(`bookflow-etl3`)이 전체 실행 순서를 오케스트레이션한다.

---

## ETL 파이프라인 구조

```
[ParallelMart — 7개 병렬 실행]
  ETL1 (S3 Raw → S3 Mart)
    ├── raw_aladin_mart      s3://raw/aladin/         → mart/aladin_books/
    ├── raw_pos_mart         s3://raw/pos-events/     → mart/sales_fact/
    ├── raw_sns_mart         s3://raw/sns/            → mart/sns_mentions/
    └── raw_event_mart       s3://raw/events/         → mart/calendar_events/

  ETL2 (RDS → S3 Mart)
    ├── rds_inventory_mart   RDS inventory_snapshot_daily → mart/inventory_daily/
    ├── rds_locations_mart   RDS locations                → mart/locations_static/
    └── rds_store_location_map_mart  RDS locations (파생) → mart/store_location_map/

         ↓ 완료 후 순차 실행

[SalesDailyAgg]
    sales_daily_agg          mart/sales_fact/ → mart/sales_daily/

         ↓

[FeaturesBuild]
    features_build           mart/* 전체 조인 → mart/features/ (S3 + GCS dual-write)
```

---

## 수동 Step Functions 실행

### 명령어

```bash
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:ap-northeast-1:354493396671:stateMachine:bookflow-etl3 \
  --input '{"trigger": "manual"}' \
  --region ap-northeast-1
```

> PowerShell 환경에서는 작은따옴표 대신 이스케이프 처리 필요:
> ```powershell
> aws stepfunctions start-execution `
>   --state-machine-arn arn:aws:states:ap-northeast-1:354493396671:stateMachine:bookflow-etl3 `
>   --input '{\"trigger\": \"manual\"}' `
>   --region ap-northeast-1
> ```

### 실행 상태 확인

```bash
# 최근 실행 목록
aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:ap-northeast-1:354493396671:stateMachine:bookflow-etl3 \
  --region ap-northeast-1

# 특정 실행 상세 (executionArn은 list-executions 결과에서 복사)
aws stepfunctions describe-execution \
  --execution-arn <executionArn> \
  --region ap-northeast-1
```

---

## 관련 인프라 파일 역할

| 파일 | 위치 | 역할 |
|------|------|------|
| `step-functions.yaml` | `BookFlowAI-Platform/infra/aws/99-glue/` | Step Functions 상태 머신 정의. ParallelMart → SalesDailyAgg → FeaturesBuild 실행 순서 및 각 Glue Job 호출 파라미터 정의 |
| `glue-catalog.yaml` | `BookFlowAI-Platform/infra/aws/99-glue/` | Glue Job 리소스 및 Glue Database 정의. 각 Job의 ScriptLocation, IAM Role, 실행 파라미터(버킷명, RDS 엔드포인트 등) 설정 |
| `sam-template.yaml` | `BookFlowAI-Platform/infra/aws/99-serverless/` | EventBridge 스케줄로 Step Functions을 자동 트리거하는 Lambda 함수 정의. `aladin-sync`(11:40 KST), `forecast-trigger`(11:43 KST) 스케줄 포함 |

---

## Glue 스크립트 상세

### ETL1 — S3 Raw → S3 Mart

#### `raw-aladin-mart/raw_aladin_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | `s3://bookflow-raw-{account}/aladin/` (GZIP NDJSON) |
| 출력 | `s3://bookflow-mart-{account}/mart/aladin_books/` (Parquet, 단일 경로) |
| 방식 | SCD Type1 — isbn13 기준 최신 레코드만 유지 |
| 중복제거 | `synced_at` 내림차순 `row_number()` → `_rn == 1` 필터 |
| 특이사항 | 내부 SCD 누적 경로(`aladin_books/`)와 mart 출력 경로(`mart/aladin_books/`) 분리. Spark lazy evaluation 문제 회피를 위해 `.cache() + .count()`로 eager evaluation 강제 |

출력 스키마:
```
isbn13, title, author, publisher, pub_date, price,
cover_url, query_type, category_id, category, rating, synced_at
```

---

#### `raw-pos-mart/raw_pos_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | `s3://bookflow-raw-{account}/pos-events/` (Firehose GZIP JSON) |
| 출력 | `s3://bookflow-mart-{account}/mart/sales_fact/` (Parquet, `sale_date` 파티션) |
| 방식 | Job bookmark 활성화 — 신규 파일만 처리, `tx_id` 기준 중복 제거 |
| 파티션 | `sale_date` (dynamic overwrite) |

출력 스키마:
```
tx_id, isbn13, qty, unit_price, total_price,
channel, location_id, ts, sale_date, sale_hour
```

---

#### `raw-sns-mart/raw_sns_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | `s3://bookflow-raw-{account}/sns/` (GZIP NDJSON) |
| 출력 | `s3://bookflow-mart-{account}/mart/sns_mentions/` (Parquet, `mention_date` 파티션) |
| 파티션 | `mention_date` (dynamic overwrite) |

출력 스키마:
```
isbn13, platform, content, sentiment, mention_count,
is_spike_seed, collected_at, is_synthetic, created_at, mention_date
```

---

#### `raw-event-mart/raw_event_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | `s3://bookflow-raw-{account}/events/` (GZIP NDJSON) |
| 출력 | `s3://bookflow-mart-{account}/mart/calendar_events/` (Parquet, `event_type` 파티션) |
| 중복제거 | `event_id` 기준 dropDuplicates |
| 파티션 | `event_type` |

출력 스키마:
```
event_id, event_type, title, start_date, end_date,
location, isbn13_list, synced_at
```

---

### ETL2 — RDS → S3 Mart

#### `rds-inventory-mart/rds_inventory_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | RDS PostgreSQL `inventory_snapshot_daily` — MAX(snapshot_date) 하루치만 읽음 |
| 출력 | `s3://bookflow-mart-{account}/mart/inventory_daily/` (Parquet, `snapshot_date` 파티션) |
| 방식 | 매 실행마다 최신 날짜 파티션만 dynamic overwrite |

출력 스키마:
```
snapshot_date, isbn13, location_id, on_hand, reserved_qty, safety_stock
```

---

#### `rds-locations-mart/rds_locations_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | RDS PostgreSQL `locations` (active=TRUE 전체) |
| 출력 | `s3://bookflow-mart-{account}/mart/locations_static/` (Parquet, 단일 경로) |
| 방식 | 매 실행 full overwrite (정적 마스터 테이블) |

출력 스키마:
```
location_id, location_type, wh_id, size, is_virtual
```

---

#### `rds-store-location-map-mart/rds_store_location_map_mart.py`

| 항목 | 내용 |
|------|------|
| 소스 | RDS PostgreSQL `locations` 기반 파생 |
| 출력 | `s3://bookflow-mart-{account}/mart/store_location_map/` (Parquet, 단일 경로) |
| 파생 규칙 | `STORE_OFFLINE`: `inventory_location_id = location_id`<br>`STORE_ONLINE (is_virtual)`: `inventory_location_id = WH의 location_id` (wh_id 기준 self-join, WH location 없으면 wh_id 직접 사용) |

출력 스키마:
```
store_id, location_id, inventory_location_id
```

---

### 집계 — Mart 내부

#### `sales-daily-agg/sales_daily_agg.py`

| 항목 | 내용 |
|------|------|
| 소스 | `mart/sales_fact/` |
| 출력 | `mart/sales_daily/` (Parquet, `sale_date` 파티션) |
| 집계 단위 | `sale_date × isbn13 × store_id × channel` |
| 집계 항목 | `qty_sold`, `revenue`, `avg_price`, `tx_count`, `last_tx_at` |
| 전처리 | 실행 전 `mart/sales_fact/` + `mart/sales_daily/` 구형식 디렉토리 자동 삭제 |

출력 스키마:
```
sale_date, isbn13, store_id, channel,
qty_sold, revenue, avg_price, tx_count, last_tx_at, aggregated_at
```

---

#### `features-build/features_build.py`

| 항목 | 내용 |
|------|------|
| 소스 | mart 하위 전체 테이블 (inventory_daily, locations_static, store_location_map, sales_daily, calendar_events, sns_mentions, aladin_books) |
| 출력 | `mart/features/` (S3, `feature_date` 파티션) + `gs://{GCS_BUCKET}/mart/features/` (GCS dual-write) |
| 출력 단위 | `feature_date × isbn13 × store_id` |
| GCS 연결 | Glue Network Connection → TGW → Site-to-Site VPN → GCP → PSC → storage.googleapis.com |

주요 feature 항목:
```
-- grain
feature_date, isbn13, store_id

-- 위치
location_id, inventory_location_id, location_type, wh_id, size, is_virtual

-- 서적 속성
category_id, category_name, publisher, author, price_standard, price_sales,
price_tier, sales_point, book_age_days, is_bestseller_flag,
author_past_books_count, author_debut_year, author_experience_years

-- 캘린더
is_holiday, holiday_name, season, day_of_week, is_weekend, month, event_nearby_days

-- SNS (7일 롤링)
sns_mentions_1d, sns_mentions_7d

-- 재고
on_hand, reserved_qty, safety_stock, on_hand_total, days_since_last_stockout

-- 실적 레이블
qty_sold, revenue, avg_price, tx_count
```

---

### GCS Dual-write

#### `mart_table_gcs.py`

| 항목 | 내용 |
|------|------|
| 용도 | S3 Mart 단일 테이블 → GCS 복사 (단독 실행용) |
| 대상 테이블 | `TABLE_NAME` 인수로 지정 — `inventory_daily` / `locations_static` / `store_location_map` |
| 실행 인수 | `MART_BUCKET`, `GCS_BUCKET`, `gcp_secret_arn`, `TABLE_NAME` |
| 특이사항 | `features_build`의 GCS dual-write와 별개. 개별 mart 테이블 재동기화 시 사용 |

---

## S3 경로 요약

| Mart 테이블 | S3 경로 | 파티션 |
|-------------|---------|--------|
| aladin_books | `mart/aladin_books/` | 없음 (full overwrite) |
| sales_fact | `mart/sales_fact/` | `sale_date=` |
| sns_mentions | `mart/sns_mentions/` | `mention_date=` |
| calendar_events | `mart/calendar_events/` | `event_type=` |
| inventory_daily | `mart/inventory_daily/` | `snapshot_date=` |
| locations_static | `mart/locations_static/` | 없음 (full overwrite) |
| store_location_map | `mart/store_location_map/` | 없음 (full overwrite) |
| sales_daily | `mart/sales_daily/` | `sale_date=` |
| features | `mart/features/` | `feature_date=` |

버킷 명칭:
- Raw: `bookflow-raw-354493396671`
- Mart: `bookflow-mart-354493396671`
- Glue Scripts: `bookflow-glue-scripts-354493396671`

---

## 구형식 디렉토리 자동 정리

모든 스크립트는 실행 시작 시 `_clean_old_batch_dirs()` 함수를 호출하여  
Hive 파티션 형식(`key=value/`)이 아닌 구형식 `{batch_id}/` 디렉토리를 자동 삭제한다.  
이는 파티션 형식 혼재로 인한 `ConflictingDirectoryStructures` 오류를 방지하기 위함이다.

---

## 배포

### 자동 배포 (GitHub Actions)

`main` 브랜치에 `glue-jobs/` 또는 `gcs-connector-hadoop3-latest.jar` 변경이 push되면  
`.github/workflows/sync-glue-scripts.yml` 이 자동으로 S3에 sync한다.

- 스크립트: `glue-jobs/**/*.py` → `s3://bookflow-glue-scripts-{account}/scripts/{filename}.py` (flat)
- JAR: `gcs-connector-hadoop3-latest.jar` → `s3://bookflow-glue-scripts-{account}/jars/gcs-connector-hadoop3-latest.jar`

GitHub Actions 동작에 필요한 Secrets (레포 Settings → Secrets and variables → Actions):

| Secret 이름 | 값 |
|---|---|
| `AWS_ACCESS_KEY_ID` | AWS IAM 액세스 키 ID |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM 시크릿 키 |
| `AWS_ACCOUNT_ID` | `994878981869` |

### 수동 배포 (전체 인프라 재배포 시)

`deploy-remaining.sh` 실행 시 8번 단계에서 자동으로 S3 sync 및 jar 업로드 수행:

```bash
# BookFlowAI-Platform 루트에서 실행
bash scripts/aws/deploy-remaining.sh
```

- 스크립트 경로: `BookFlowAI-Apps/glue-jobs/**/*.py` → S3 `scripts/` (flat)
- JAR 경로: `BookFlowAI-Apps/gcs-connector-hadoop3-latest.jar` → S3 `jars/`

### Glue Job 리소스 정의 변경 시

```bash
aws cloudformation deploy \
  --template-file BookFlowAI-Platform/infra/aws/99-glue/glue-catalog.yaml \
  --stack-name bookflow-99-glue-catalog \
  --capabilities CAPABILITY_NAMED_IAM \
  --region ap-northeast-1
```

### Step Functions 정의 변경 시

```bash
aws cloudformation deploy \
  --template-file BookFlowAI-Platform/infra/aws/99-glue/step-functions.yaml \
  --stack-name bookflow-99-step-functions \
  --capabilities CAPABILITY_NAMED_IAM \
  --region ap-northeast-1
```
