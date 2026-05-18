from fastapi import HTTPException

from src.routes import forecast


def test_new_book_inference_response_maps_wh_quantities(monkeypatch):
    monkeypatch.setattr(
        forecast,
        "_load_active_locations",
        lambda: [
            (15, "WH1", "WH", 1),
            (16, "WH2", "WH", 2),
        ],
    )

    req = forecast.NewBookPredictReq(isbn13="9791234567890", publisher_id=7)
    resp = forecast._response_from_gcp_new_book(
        req,
        {
            "wh1_qty": 120,
            "wh2_qty": 80,
            "lead_days": 30,
            "model_version": "bookflow_new_books_forecast",
        },
    )

    assert resp.model_version == "bookflow_new_books_forecast"
    assert resp.total_30d == 200
    assert [p.location_id for p in resp.predictions] == [15, 16]
    assert [p.wh_id for p in resp.predictions] == [1, 2]


def test_new_book_inference_requires_gcp_url(monkeypatch):
    monkeypatch.setattr(forecast.settings, "gcp_new_book_inference_url", None)

    with monkeypatch.context() as m:
        m.setattr(forecast.settings, "allow_mock_fallback", False)
        try:
            forecast._call_gcp_new_book_inference(
                forecast.NewBookPredictReq(isbn13="9791234567890")
            )
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("expected HTTPException")


def test_build_vertex_instances_has_required_champion_features(monkeypatch):
    monkeypatch.setattr(
        forecast,
        "_load_active_locations",
        lambda: [
            (1, "Store 1", "STORE_OFFLINE", 1),
            (2, "Store 2", "STORE_ONLINE", 2),
            (15, "WH1", "WH", 1),
        ],
    )

    instances = forecast._build_vertex_instances(
        forecast.NewBookPredictReq(
            isbn13="9791234567890",
            publisher_id=7,
            category="fiction",
            expected_price=18000,
        )
    )

    required = {
        "store_id", "wh_id", "channel", "location_type", "store_size", "region",
        "on_hand", "reserved_qty", "safety_stock", "holiday_flag",
        "day_of_week", "month", "weekend_flag", "event_nearby_days",
        "sns_mentions_1d", "sns_mentions_7d", "book_age_days",
        "days_since_last_stockout", "category_id", "price_tier", "sales_point",
        "bestseller_flag", "author_experience_years", "qty_lag_1", "qty_lag_7",
        "qty_rolling_7d", "qty_rolling_28d", "demand_segment",
    }
    assert len(instances) == 2
    assert required <= set(instances[0])
    assert instances[0]["demand_segment"] == "high"
