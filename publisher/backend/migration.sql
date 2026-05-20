-- publisher-api DB 마이그레이션
-- 실행 시점: publisher-api 최초 배포 전 (Ansible Playbook 또는 수동)
-- 멱등성: IF NOT EXISTS 로 중복 실행 안전
-- 연결: Ansible Control Node → Transit Gateway → RDS (Data VPC)

-- new_book_requests 테이블에 첨부파일 S3 키 컬럼 추가
ALTER TABLE new_book_requests
    ADD COLUMN IF NOT EXISTS attachment_s3_key TEXT;

-- new_book_requests 테이블에 정가 컬럼 추가 (필수 · 0 초과)
-- 도입 배경: publisher 채널 신간이 books.price_sales=NULL 로 등록 → ecs-sim catalog 필터
--   (price > 0) 에서 TypeError 발생 → POS 시뮬 crash loop (2026-05-20 16시 incident).
-- 절차: 1) NULLABLE 추가 → 2) 기존 row 1 (price_sales NULL) 무해한 default backfill →
--        3) NOT NULL 승격. 멱등성 위해 information_schema 검사 후에만 NOT NULL 적용.
ALTER TABLE new_book_requests
    ADD COLUMN IF NOT EXISTS price_sales INTEGER;

-- 기존 NULL row backfill (1 원 sentinel · 운영 시 본사가 보정).
UPDATE new_book_requests SET price_sales = 1 WHERE price_sales IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'new_book_requests'
          AND column_name = 'price_sales'
          AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE new_book_requests ALTER COLUMN price_sales SET NOT NULL;
    END IF;
END$$;

COMMENT ON COLUMN new_book_requests.price_sales
    IS '정가 (원, 1 이상). publisher-api 폼 필수 입력 · books.price_sales 로 전파.';

-- ON CONFLICT (isbn13) DO NOTHING 을 위한 UNIQUE 제약 추가
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'new_book_requests'::regclass
          AND contype = 'u'
          AND conname = 'new_book_requests_isbn13_key'
    ) THEN
        ALTER TABLE new_book_requests ADD CONSTRAINT new_book_requests_isbn13_key UNIQUE (isbn13);
    END IF;
END$$;

COMMENT ON COLUMN new_book_requests.attachment_s3_key
    IS 'S3 키 (예: attachments/9791234567890/marketing.pdf). publisher-api 경유 제출 시만 존재.';

-- publisher_api DB 전용 Role 생성 (최소 권한 원칙)
-- 실행 전 superuser 로 접속 필요
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'publisher_api') THEN
        CREATE ROLE publisher_api LOGIN;
    END IF;
END$$;

-- new_book_requests: INSERT + SELECT (UPDATE/DELETE 불가 — 상태변경은 decision-svc 가 담당)
GRANT INSERT, SELECT ON new_book_requests TO publisher_api;
-- books 마스터 UPSERT (신규 ISBN 등록용)
GRANT INSERT ON books TO publisher_api;
-- audit_log INSERT
GRANT INSERT ON audit_log TO publisher_api;
-- 시퀀스 사용 권한 (RETURNING id 를 위해 필요)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO publisher_api;
