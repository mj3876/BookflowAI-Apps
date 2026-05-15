# rds-inventory-seed

## 목적
`inventory_snapshot_daily` 테이블에 초기 시드 데이터(14일치)를 생성하는 one-time Glue Job.  
테이블이 비어있을 때만 실행하며, 이미 데이터가 있으면 스킵한다.

## 실행 조건
- `inventory_snapshot_daily` 테이블 row 수 = 0 일 때만 INSERT
- 이미 데이터 존재 시 자동 스킵 (멱등성 보장)

## 동작 흐름
1. RDS `inventory` 테이블 읽기
2. 오늘 기준 14일치 날짜 생성 (0=오늘 ~ 13=13일 전)
3. `inventory` × `14일` CrossJoin → 랜덤 오차 적용
4. `inventory_snapshot_daily` 테이블에 APPEND

## 파라미터 (Glue Job Arguments)

| 파라미터 | 설명 |
|----------|------|
| `--RDS_ENDPOINT` | RDS PostgreSQL 엔드포인트 |
| `--RDS_PORT` | 포트 (기본 5432) |
| `--RDS_DBNAME` | 데이터베이스명 |
| `--RDS_SECRET_ARN` | Secrets Manager ARN (username/password) |

## CFN 리소스
`infra/aws/99-glue/glue-catalog.yaml` → `RdsInventorySeedJob`

## 주의사항
- `sys.exit(0)` 사용 금지: Glue가 FAILED로 처리함 → if/else 구조 사용
- Glue Connection: `bookflow-rds` (VPC 내 RDS 접근용)
- WorkerType: G.1X × 2 workers, Timeout: 30분
