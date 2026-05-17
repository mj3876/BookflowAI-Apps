"""수신자 결정 모듈.

event_type → Logic Apps payload 의 recipients 배열을 결정한다.
연락처는 settings (K8s ConfigMap NOTIFICATION_CONTACT_*) 에서 읽는다.

학습환경 3개 통합 매핑:
  contact_hq_emails     = 본사+경영진  (redfox@yonsei.ac.kr)
  contact_wh_emails     = 물류센터 전체 (ms8405493@gmail.com)
  contact_branch_emails = 지점 전체    (2023240672@yonsei.ac.kr)
"""
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


def _dedup(recipients: list[dict]) -> list[dict]:
    """동일 address 중복 제거 (같은 이메일로 여러 역할 매핑 시 방어)."""
    seen: set[str] = set()
    result = []
    for r in recipients:
        if r["address"] not in seen:
            seen.add(r["address"])
            result.append(r)
    return result


def _is_wh(loc_type: str | None) -> bool:
    return bool(loc_type and loc_type.upper() == "WH")


def _is_branch(loc_type: str | None) -> bool:
    return bool(loc_type and "STORE" in loc_type.upper())


def _stock_depart_recipients(payload: dict | None) -> list[dict]:
    """StockDepartPending: 도착지(target) 담당자에게 운송 시작 메일 발송.

    수신 규칙 (출발지 → 도착지 조합별):
      도착지 = WH     : 출발지가 HQ(None) 또는 다른 WH 인 경우만 물류센터 수신
      도착지 = BRANCH : 출발지가 WH 또는 다른 BRANCH 인 경우만 지점 수신
      도착지 = HQ     : 본사는 도착지가 될 수 없으므로 발송 안 함
    """
    p = payload or {}
    tgt = p.get("target_location_type") or ""
    src = p.get("source_location_type")  # None = HQ/출판사 (source_location_id IS NULL)

    if _is_wh(tgt):
        # 출발지가 HQ(None) 또는 다른 WH 일 때만 물류센터 수신
        if src is None or _is_wh(src):
            return _wh()
        return []

    if _is_branch(tgt):
        # 출발지가 WH 또는 다른 BRANCH 일 때만 지점 수신
        if _is_wh(src) or _is_branch(src):
            return _branches()
        return []

    return []  # 도착지가 HQ 또는 미분류 → 발송 안 함


def _stock_arrival_recipients(payload: dict | None) -> list[dict]:
    """StockArrivalPending: 출발지(source) 담당자에게 운송 완료 확인 메일 발송.

    수신 규칙 (출발지 → 도착지 조합별):
      출발지 = HQ(None) : 도착지가 WH 인 경우 본사 수신
      출발지 = WH       : 도착지가 다른 WH 또는 BRANCH 인 경우 물류센터 수신
      출발지 = BRANCH   : 도착지가 다른 BRANCH 인 경우 지점 수신
    """
    p = payload or {}
    src = p.get("source_location_type")  # None = HQ/출판사
    tgt = p.get("target_location_type") or ""

    if src is None:
        # 출발지 = HQ: 도착지가 WH 인 경우 본사가 확인메일 받음
        if _is_wh(tgt):
            return _hq()
        return []

    if _is_wh(src):
        # 출발지 = WH: 도착지가 다른 WH 또는 BRANCH 이면 물류센터 수신
        if _is_wh(tgt) or _is_branch(tgt):
            return _wh()
        return []

    if _is_branch(src):
        # 출발지 = BRANCH: 도착지가 다른 BRANCH 이면 지점 수신
        if _is_branch(tgt):
            return _branches()
        return []

    return []


def get_recipients(event_type: str, payload: dict | None = None) -> list[dict]:
    """Logic Apps trigger payload 에 포함할 recipients 배열 반환."""
    # 운송시작/완료는 출발지·도착지 유형에 따라 수신자를 동적 결정
    if event_type == "StockDepartPending":
        return _dedup(_stock_depart_recipients(payload))
    if event_type == "StockArrivalPending":
        return _dedup(_stock_arrival_recipients(payload))

    mapping: dict[str, list[dict]] = {
        # 본사 단독
        "AutoExecutedUrgent":  _hq(),
        "NewBookRequest":      _hq(),
        "ReturnPending":       _hq(),
        "BranchFeedback":      _hq(),

        # 본사 + 물류센터
        "SpikeUrgent":         _hq() + _wh(),
        "ApprovalDelayed":     _hq() + _wh(),
        "InboundRejected":     _hq() + _wh(),
        "NegotiationDelay":    _hq() + _wh(),

        # 전 레벨 — 본사+경영진+물류센터+지점
        "ForecastCompleted":   _hq() + _wh() + _branches(),
        "DailyPlanFinalized":  _hq() + _wh() + _branches(),
        "DeliveryCompleted":   _hq() + _wh() + _branches(),

        # 승인요청 — 출발지/도착지 유형 무관하게 전 레벨 수신
        "OrderPending":        _hq() + _wh() + _branches(),

        # Redis/웹소켓 전용 (이메일 불필요)
        "OrderApproved": [],
        "OrderRejected": [],
        "OrderExecuted": [],
    }
    return _dedup(mapping.get(event_type, []))
