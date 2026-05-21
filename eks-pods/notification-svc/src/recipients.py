"""수신자 결정 모듈.

event_type → Logic Apps payload 의 recipients 배열을 결정한다.
연락처는 settings (K8s ConfigMap NOTIFICATION_CONTACT_*) 에서 읽는다.

학습환경 3개 통합 매핑 (그룹 이벤트용):
  contact_hq_emails     = 본사+경영진  (woohek00@gmail.com)
  contact_wh_emails     = 물류센터 전체 (rladudgjs0427@gmail.com)
  contact_branch_emails = 지점 전체    (ms8405493@gmail.com)

지점·물류센터 개별 담당자 매핑 (StockDepart/Arrival 전용):
  contact_location_contacts_json = JSON {"location_id": "email", ...}
  → locations 테이블 PK 기반 (1~16)
  → 해당 location_id 담당자에게만 발송 (브로드캐스트 X)
"""
import json

from .settings import settings


def _parse(raw: str, display: str) -> list[dict]:
    return [
        {"address": e.strip(), "displayName": display}
        for e in raw.split(",")
        if e.strip()
    ]


def _hq() -> list[dict]:
    return _parse(settings.contact_hq_emails, "본사/경영진")

def _wh() -> list[dict]:
    return _parse(settings.contact_wh_emails, "물류센터")

def _branches() -> list[dict]:
    return _parse(settings.contact_branch_emails, "지점")


def _location_contacts() -> dict[int, str]:
    """NOTIFICATION_LOCATION_CONTACTS_JSON → {location_id: email}."""
    raw = settings.contact_location_contacts_json.strip()
    if not raw:
        return {}
    try:
        return {int(k): v for k, v in json.loads(raw).items()}
    except Exception:
        return {}


def _publisher(payload: dict | None) -> list[dict]:
    """신간 요청서의 출판사 담당자 이메일 (new_book_requests.requester_email).

    승인(stage=APPROVED) 시 출판사에게 최종 발주명세 메일을 보내기 위한 수신자.
    requester_email 미존재(구 데이터/신생 미입력) → 빈 리스트.
    """
    email = (payload or {}).get("requester_email")
    if not email or not str(email).strip():
        return []
    return [{"address": str(email).strip(), "displayName": "출판사"}]


def _location_recipient(location_id, display_name: str | None = None) -> list[dict]:
    """location_id 담당자 1명만 반환. 미등록이면 빈 리스트."""
    if location_id is None:
        return []
    contacts = _location_contacts()
    email = contacts.get(int(location_id))
    if not email or not email.strip():
        return []
    return [{"address": email.strip(), "displayName": display_name or f"담당자({location_id})"}]


def _dedup(recipients: list[dict]) -> list[dict]:
    """동일 address 중복 제거 (같은 이메일로 여러 역할 매핑 시 방어)."""
    seen: set[str] = set()
    result = []
    for r in recipients:
        if r["address"] not in seen:
            seen.add(r["address"])
            result.append(r)
    return result


def _stock_depart_recipients(payload: dict | None) -> list[dict]:
    """StockDepartPending: 도착지(target) 담당자 1명에게만 운송 시작 메일 발송.

    target_location_id 로 개별 담당자를 조회.
    미등록(PUBLISHER_ORDER 등) → 빈 리스트.
    """
    p = payload or {}
    return _location_recipient(p.get("target_location_id"), p.get("target_location"))


def _stock_arrival_recipients(payload: dict | None) -> list[dict]:
    """StockArrivalPending: 출발지(source) 담당자 1명에게만 운송 완료 확인 메일 발송.

    source_location_id 로 개별 담당자를 조회.
    출발지가 출판사(source_location_id IS NULL) → 빈 리스트.
    """
    p = payload or {}
    return _location_recipient(p.get("source_location_id"), p.get("source_location"))


def get_recipients(event_type: str, payload: dict | None = None) -> list[dict]:
    """Logic Apps trigger payload 에 포함할 recipients 배열 반환."""
    # 운송시작/완료는 출발지·도착지 유형에 따라 수신자를 동적 결정
    if event_type == "StockDepartPending":
        return _dedup(_stock_depart_recipients(payload))
    if event_type == "StockArrivalPending":
        return _dedup(_stock_arrival_recipients(payload))
    # 신간: 발견(DISCOVERED) 단계는 본사 매니저 알림(1-2),
    #       승인(APPROVED) 단계는 본사 + 출판사 발주명세 메일(1-7).
    if event_type == "NewBookRequest":
        if (payload or {}).get("stage") == "APPROVED":
            return _dedup(_hq() + _publisher(payload))
        return _dedup(_hq())

    mapping: dict[str, list[dict]] = {
        # 본사 단독
        "AutoExecutedUrgent":  _hq(),
        "ReturnPending":       _hq(),
        "BranchFeedback":      _hq(),

        # 본사 단독 (긴급발주 포함)
        "SpikeUrgent":         _hq(),
        "ApprovalDelayed":     _hq() + _wh(),
        "InboundRejected":     _hq() + _wh(),
        "NegotiationDelay":    _hq() + _wh(),

        # 전 레벨 — 본사+경영진+물류센터+지점
        "ForecastCompleted":   _hq() + _wh() + _branches(),
        "DailyPlanFinalized":  _hq() + _wh() + _branches(),

        # 승인요청 — 출발지/도착지 유형 무관하게 전 레벨 수신
        "OrderPending":        _hq() + _wh() + _branches(),

        # Redis/웹소켓 전용 (이메일 불필요)
        "OrderApproved": [],
        "OrderRejected": [],
        "OrderExecuted": [],
    }
    return _dedup(mapping.get(event_type, []))
