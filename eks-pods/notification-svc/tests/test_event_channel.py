"""EVENT_CHANNEL 매트릭스 단위 테스트 · 시트04 Pub/Sub 1:1 정렬.

시트04 Redis 채널 4종:
  stock.changed     - inventory-svc 직접 publish (notification-svc 경유 X)
  order.pending     - OrderPending 단 1종
  spike.detected    - SpikeUrgent 단 1종
  newbook.request   - NewBookRequest 단 1종

12 events 중 Redis 채널에 발행되는 것은 위 3개. 나머지 9개는 None (Logic Apps 만).
"""
from src.routes.notification import EVENT_CHANNEL


REDIS_PUB_EVENTS = {"OrderPending", "SpikeUrgent", "NewBookRequest"}
ALL_EVENTS_12 = {
    "OrderPending", "OrderApproved", "OrderRejected",
    "AutoExecutedUrgent", "AutoRejectedBatch", "SpikeUrgent",
    "StockDepartPending", "StockArrivalPending", "NewBookRequest",
    "ReturnPending", "LambdaAlarm", "DeploymentRollback",
}


def test_event_channel_has_all_12_events():
    """시트04 12 events 가 매트릭스에 모두 등록."""
    assert set(EVENT_CHANNEL.keys()) == ALL_EVENTS_12


def test_only_three_events_publish_to_redis():
    """Redis 채널 발행 대상은 정확히 3종."""
    publishing = {ev for ev, ch in EVENT_CHANNEL.items() if ch is not None}
    assert publishing == REDIS_PUB_EVENTS


def test_order_pending_to_order_pending_channel():
    assert EVENT_CHANNEL["OrderPending"] == "order.pending"


def test_spike_urgent_to_spike_detected_channel():
    assert EVENT_CHANNEL["SpikeUrgent"] == "spike.detected"


def test_newbook_request_to_newbook_request_channel():
    assert EVENT_CHANNEL["NewBookRequest"] == "newbook.request"


def test_order_approved_no_redis_publish():
    """승인 후 OrderApproved 는 Logic Apps 만 (시트04 정합)."""
    assert EVENT_CHANNEL["OrderApproved"] is None


def test_order_rejected_no_redis_publish():
    assert EVENT_CHANNEL["OrderRejected"] is None


def test_auto_executed_no_redis_publish():
    assert EVENT_CHANNEL["AutoExecutedUrgent"] is None


def test_no_invalid_channel_names():
    """발행 대상 채널은 시트04 4종 중 하나여야 함."""
    valid = {"order.pending", "spike.detected", "newbook.request", "stock.changed", None}
    for ev, ch in EVENT_CHANNEL.items():
        assert ch in valid, f"{ev}: {ch} not in 시트04 채널 목록"
