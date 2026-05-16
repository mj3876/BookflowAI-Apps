"""수신자 결정 모듈.

event_type → Logic Apps payload 의 recipients 배열을 결정한다.
연락처는 settings (K8s ConfigMap NOTIFICATION_CONTACT_*) 에서 읽는다.

학습환경 3개 통합 매핑:
  contact_hq_emails     = 본사+경영진  (redfox@yonsei.ac.kr)
  contact_wh_emails     = 물류센터 전체 (ms8405493@gmail.com)
  contact_branch_emails = 지점 전체    (redfox@yonsei.ac.kr)
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


def get_recipients(event_type: str, payload: dict | None = None) -> list[dict]:
    """Logic Apps trigger payload 에 포함할 recipients 배열 반환."""
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

        # 운송시작 — 도착지가 지점일 수 있으므로 전 레벨
        "StockDepartPending":  _hq() + _wh() + _branches(),

        # 운송완료 — 출발지가 지점(REBALANCE)일 수 있으므로 전 레벨
        "StockArrivalPending": _hq() + _wh() + _branches(),

        # Redis/웹소켓 전용 (이메일 불필요)
        "OrderApproved": [],
        "OrderRejected": [],
        "OrderExecuted": [],
    }
    return _dedup(mapping.get(event_type, []))
