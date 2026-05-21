"""
BookFlow Publisher API — FastAPI 메인 앱

역할: 출판사로부터 신간 요청서(JSON + 첨부파일)를 수신하고
      RDS new_book_requests 테이블에 저장 + 첨부파일은 S3 업로드.

엔드포인트:
  GET  /health                                  — nginx 헬스체크 / ALB 헬스체크용
  POST /api/v1/new-book-requests                — 출판사 신간 요청서 제출 (인증 필요)
  GET  /api/v1/new-book-requests                — publisher-watcher 1분 폴링용 (status=NEW 목록)
  GET  /api/v1/new-book-requests/{isbn13}/status — 출판사 제출 상태 조회 (인증 필요)

연동 흐름:
  [출판사 브라우저]
      → POST /api/v1/new-book-requests (X-Api-Key 헤더)
      → ALB (50-network-traffic/alb-external.yaml) · WAF 검사
      → nginx :80 → proxy_pass uvicorn :8000
      → RDS new_book_requests INSERT  +  S3 첨부파일 PUT

  [publisher-watcher CronJob, 매 1분]
      → GET /api/v1/new-book-requests?status=NEW
      → ALB → nginx → uvicorn
      → RDS new_book_requests SELECT → {"items": [...]} 반환
      → watcher 가 books 마스터 UPSERT + Redis pub/sub 알림
"""
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import db, storage
from .auth import verify_api_key
from .models import StatusResponse, SubmitResponse
from .settings import settings

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("publisher-api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 시작·종료 시 DB 풀 생명주기 관리."""
    db.init_pool()
    yield
    db.close_pool()


app = FastAPI(
    title="BookFlow Publisher API",
    version="1.0.0",
    description="출판사 전용 신간 요청서 수신 API",
    lifespan=lifespan,
)

# CORS: 동일 도메인(nginx 가 서빙하는 index.html)에서 fetch() 호출하므로
# 실제로는 same-origin 이지만, 로컬 개발 편의를 위해 열어둠.
# 프로덕션에서는 ALB DNS 또는 Route53 도메인만 허용하도록 좁힐 것.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ─── 헬스체크 ──────────────────────────────────────────────────────────────────

@app.get("/health", tags=["infra"])
def health():
    """nginx ValidateService / ALB 헬스체크용. DB 연결 여부와 무관하게 200 반환."""
    return {"status": "ok", "service": "publisher-api"}


# ─── 신간 요청서 제출 (출판사 → 시스템) ───────────────────────────────────────

@app.post(
    "/api/v1/new-book-requests",
    status_code=201,
    response_model=SubmitResponse,
    tags=["publisher"],
    summary="신간 요청서 제출",
)
async def submit_new_book_request(
    # ── 필수 필드 ──
    isbn13: str = Form(..., description="ISBN-13 (13자리 숫자)"),
    title: str = Form(..., description="도서명"),
    author: str = Form(..., description="저자명"),
    # 정가 (필수 · 0 초과). books.price_sales NULL → ecs-sim catalog TypeError 의 근본 차단.
    price_sales: int = Form(..., gt=0, description="정가 (원, 1 이상)"),
    # 결과 통보용 출판사 담당자 이메일 (필수) — 승인 시 발주명세 메일 수신처.
    requester_email: str = Form(..., description="출판사 담당자 이메일 (결과 통보용)"),
    # 장르 (필수) — 신간은 판매 이력이 없으므로 같은 장르 도서들의 피처를 평균내어
    # cold-start 수요예측을 수행한다 (forecast-svc _assemble_new_book_features).
    # 권장 값: 소설/시/희곡 · 인문학 · 어린이 · 경제경영 · 컴퓨터/모바일 · 자기계발 ·
    #          건강/취미 · 예술/대중문화 · 사회과학 · 역사 · 과학 · 에세이 · 청소년 · 종교/역학
    genre: str = Form(..., description="장르 (필수 · 신간 cold-start 피처 수집 기준)"),
    # ── 선택 필드 ──
    # 출판사 코드. 신생 출판사는 코드를 모르므로 선택 — 미입력 시 publisher_name 으로 등록/조회.
    publisher_id: Optional[str] = Form(None, description="출판사 코드 (기존 출판사) · 신생은 비우고 publisher_name 입력"),
    publisher_name: Optional[str] = Form(None, description="출판사명 (신생 출판사 · publisher_id 미입력 시 필수)"),
    expected_pub_date: Optional[str] = Form(None, description="출판 예정일 YYYY-MM-DD"),
    estimated_initial_sales: int = Form(0, ge=0, description="예상 초판 판매량"),
    marketing_plan: Optional[str] = Form("", description="마케팅 계획"),
    # JSON 배열 문자열로 전달 (multipart 한계)
    similar_books: Optional[str] = Form("[]", description='유사 도서 ISBN13 배열 JSON 예: ["9791234567890"]'),
    target_segments: Optional[str] = Form("[]", description='독자 세그먼트 배열 JSON 예: ["10대","판타지독자"]'),
    # 첨부파일 (선택: 마케팅 자료, 원고 샘플 등)
    attachment: Optional[UploadFile] = File(None, description="첨부파일 (PDF/Word/이미지, 최대 10MB)"),
    # API 키 인증 (auth.py verify_api_key Depends)
    _: None = Depends(verify_api_key),
):
    """출판사가 신간 요청서를 제출한다.

    처리 순서:
    1. 첨부파일 S3 업로드 (있을 경우)
    2. books 마스터 테이블 UPSERT (신규 ISBN 등록)
    3. new_book_requests INSERT (ON CONFLICT isbn13 DO NOTHING — 중복 방지)
    4. audit_log INSERT
    5. 응답 반환 (id, isbn13, status=NEW)

    이후 publisher-watcher CronJob 이 1분 이내에 폴링하여 DB 동기화 + Redis 알림 발행.
    """
    # ISBN-13 형식 검사 (13자리 숫자)
    if not isbn13.isdigit() or len(isbn13) != 13:
        raise HTTPException(status_code=422, detail="isbn13 은 13자리 숫자여야 합니다")

    # 출판사 식별: 기존 출판사는 publisher_id, 신생 출판사는 publisher_name 으로 등록.
    publisher_id = (publisher_id or "").strip() or None
    publisher_name = (publisher_name or "").strip() or None
    if not publisher_id and not publisher_name:
        raise HTTPException(
            status_code=422,
            detail="publisher_id (기존) 또는 publisher_name (신생) 중 하나는 필수입니다",
        )

    # ── 1. 첨부파일 S3 업로드 ──────────────────────────────────────────────────
    attachment_s3_key: Optional[str] = None
    if attachment and attachment.filename:
        data = await attachment.read()
        attachment_s3_key = storage.upload_attachment(
            isbn13=isbn13,
            filename=attachment.filename,
            data=data,
            content_type=attachment.content_type or "application/octet-stream",
        )

    # ── 2. similar_books / target_segments JSON 파싱 ──────────────────────────
    try:
        similar_list: list[str] = json.loads(similar_books or "[]")
        segment_list: list[str] = json.loads(target_segments or "[]")
    except json.JSONDecodeError:
        similar_list, segment_list = [], []

    # ── 3. RDS INSERT ─────────────────────────────────────────────────────────
    with db.db_conn() as conn:
        with conn.cursor() as cur:
            # 신생 출판사: publisher_id 미입력 → publisher_name 으로 publishers upsert 후 id 확보.
            # publishers.name 은 UNIQUE → ON CONFLICT (name) 로 멱등. contact_email 은 requester_email 로 보강.
            if not publisher_id:
                cur.execute(
                    """
                    INSERT INTO publishers (name, contact_email)
                    VALUES (%s, %s)
                    ON CONFLICT (name) DO UPDATE
                        SET contact_email = COALESCE(publishers.contact_email, EXCLUDED.contact_email)
                    RETURNING publisher_id
                    """,
                    (publisher_name, requester_email),
                )
                publisher_id = str(cur.fetchone()[0])

            # books 마스터 UPSERT
            # publisher-watcher poll.py 의 BOOKS_UPSERT_SQL 과 동일 패턴
            # price_sales 를 함께 채워야 ecs-sim catalog 필터 (price > 0) 가 정상 동작.
            cur.execute(
                """
                INSERT INTO books
                    (isbn13, title, author, category_name, price_sales, source, active, discontinue_mode)
                VALUES (%s, %s, %s, %s, %s, 'PUBLISHER_REQUEST', TRUE, 'NONE')
                ON CONFLICT (isbn13) DO NOTHING
                """,
                (isbn13, title, author, genre, price_sales),
            )

            # new_book_requests INSERT
            # attachment_s3_key / price_sales / requester_email 컬럼은 ansible migration 적용 후 사용 가능
            cur.execute(
                """
                INSERT INTO new_book_requests
                    (isbn13, publisher_id, title, author, genre,
                     expected_pub_date, estimated_initial_sales, marketing_plan,
                     similar_books, target_segments, price_sales, requester_email, attachment_s3_key, status)
                VALUES (%s, %s, %s, %s, %s,
                        %s, %s, %s,
                        %s::jsonb, %s::jsonb, %s, %s, %s, 'NEW')
                ON CONFLICT (isbn13) DO NOTHING
                RETURNING id, created_at
                """,
                (
                    isbn13, publisher_id, title, author, genre,
                    expected_pub_date or None,
                    estimated_initial_sales,
                    marketing_plan or "",
                    json.dumps(similar_list),
                    json.dumps(segment_list),
                    price_sales,
                    requester_email,
                    attachment_s3_key,
                ),
            )
            row = cur.fetchone()

            # ON CONFLICT DO NOTHING 으로 중복 isbn13 은 None 반환
            if row is None:
                raise HTTPException(
                    status_code=409,
                    detail=f"ISBN {isbn13} 에 대한 요청이 이미 존재합니다. 상태 조회 API를 이용해 주세요.",
                )
            request_id, created_at = row

            # audit_log 기록 (누가 언제 어떤 요청을 제출했는지 추적)
            cur.execute(
                """
                INSERT INTO audit_log
                    (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('publisher', %s, 'newbook.submitted', 'new_book_requests', %s, %s)
                """,
                (
                    publisher_id,
                    str(request_id),
                    json.dumps({"isbn13": isbn13, "title": title, "has_attachment": attachment_s3_key is not None}),
                ),
            )
        conn.commit()

    log.info("new_book_request created: id=%d isbn13=%s publisher=%s", request_id, isbn13, publisher_id)

    return SubmitResponse(
        id=request_id,
        isbn13=isbn13,
        status="NEW",
        attachment_s3_key=attachment_s3_key,
        created_at=created_at.isoformat(),
    )


# ─── publisher-watcher 폴링용 목록 조회 ───────────────────────────────────────

@app.get(
    "/api/v1/new-book-requests",
    tags=["internal"],
    summary="신간 요청서 목록 (publisher-watcher 폴링용)",
)
def list_new_book_requests(
    status: str = "NEW",
    limit: int = 100,
):
    """publisher-watcher CronJob 이 1분마다 호출하는 폴링 엔드포인트.

    publisher-watcher/src/poll.py 의 fetch_pending() 이 이 URL 을 호출.
    응답 형식: {"items": [...], "count": N}
    poll.py 는 body.get("items") 로 파싱하므로 이 형식을 반드시 유지.

    인증: publisher-watcher 는 현재 헤더 없이 호출 (내부망 신뢰).
    네트워크 격리로 외부 직접 접근 불가 (EKS Pod → ALB → EC2 내부 경로).
    """
    with db.db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, isbn13, publisher_id, title, author, genre,
                       expected_pub_date, estimated_initial_sales, marketing_plan,
                       similar_books, target_segments, price_sales, requester_email, status, created_at
                FROM new_book_requests
                WHERE status = %s
                ORDER BY created_at
                LIMIT %s
                """,
                (status, min(limit, 500)),  # 최대 500건 제한
            )
            rows = cur.fetchall()

    cols = [
        "id", "isbn13", "publisher_id", "title", "author", "genre",
        "expected_pub_date", "estimated_initial_sales", "marketing_plan",
        "similar_books", "target_segments", "price_sales", "requester_email", "status", "created_at",
    ]
    items = []
    for row in rows:
        d = dict(zip(cols, row))
        # date/datetime → ISO 문자열 직렬화
        if d["expected_pub_date"]:
            d["expected_pub_date"] = d["expected_pub_date"].isoformat()
        if d["created_at"]:
            d["created_at"] = d["created_at"].isoformat()
        items.append(d)

    return {"items": items, "count": len(items)}


# ─── 출판사 검색 (신청 폼 자동완성) ─────────────────────────────────────────

@app.get(
    "/api/v1/publishers",
    tags=["publisher"],
    summary="출판사 검색 (이름 자동완성)",
)
def search_publishers(q: str = "", limit: int = 1000):
    """출판사 이름 검색 — 출판사가 코드를 몰라도 이름으로 찾을 수 있게 한다.

    신청 폼이 호출하여 datalist 자동완성에 사용. q 미지정 시 전체(최대 limit) 반환.
    이름은 공개 정보 — API 키 불요(공개 read).
    """
    like = f"%{q.strip()}%" if q.strip() else "%"
    with db.db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT publisher_id, name
                  FROM publishers
                 WHERE name ILIKE %s
                 ORDER BY name
                 LIMIT %s
                """,
                (like, min(limit, 2000)),
            )
            rows = cur.fetchall()
    return {"items": [{"publisher_id": r[0], "name": r[1]} for r in rows], "count": len(rows)}


# ─── 제출 상태 조회 (출판사 확인용) ──────────────────────────────────────────

@app.get(
    "/api/v1/new-book-requests/{isbn13}/status",
    response_model=StatusResponse,
    tags=["publisher"],
    summary="신간 요청 상태 조회",
)
def get_request_status(
    isbn13: str,
    _: None = Depends(verify_api_key),
):
    """출판사가 본인 제출 요청의 현재 처리 상태를 확인한다.

    status 흐름:
      NEW → REVIEWING (본사 담당자 검토 중) → ACCEPTED / REJECTED
      (상태 변경은 decision-svc 또는 본사 대시보드에서 수행)
    """
    with db.db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, isbn13, publisher_id, title, status,
                       created_at, attachment_s3_key
                FROM new_book_requests
                WHERE isbn13 = %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (isbn13,),
            )
            row = cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"ISBN {isbn13} 에 대한 요청을 찾을 수 없습니다")

    req_id, isbn, pub_id, title, status, created_at, att_key = row
    return StatusResponse(
        id=req_id,
        isbn13=isbn,
        publisher_id=pub_id,
        title=title,
        status=status,
        created_at=created_at.isoformat(),
        attachment_s3_key=att_key,
    )
